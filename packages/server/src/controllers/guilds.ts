import log from '@kaetram/common/util/log';
import config from '@kaetram/common/config';
import { Modules, Opcodes } from '@kaetram/common/network';
import { Guild as GuildPacket } from '@kaetram/common/network/impl';

import type World from '../game/world';
import type Player from '../game/entity/character/player/player';
import type MongoDB from '@kaetram/common/database/mongodb/mongodb';
import type { GuildData, ListInfo, Member } from '@kaetram/common/types/guild';
import type { GuildPacket as OutgoingGuildPacket } from '@kaetram/common/types/messages/outgoing';

export default class Guilds {
    private database: MongoDB;

    public constructor(private world: World) {
        this.database = world.database;
    }

    /**
     * Creates a guild and stores it in the database. We also assign the guild
     * object onto the player and add the player to the guild.
     * @param player The player who is creating the guild.
     * @param name The name of the guild.
     */

    public create(
        player: Player,
        name: string,
        banner: Modules.BannerColour,
        outline: Modules.BannerOutline,
        outlineColour: Modules.BannerColour,
        crest: Modules.BannerCrests
    ): void {
        // Ensure the player isn't already in a guild.
        if (player.guild) return player.notify('You are already in a guild.');

        // Prevent players from creating a guild if they haven't finished the tutorial.
        if (!player.quests.isTutorialFinished())
            return player.guildNotify('You must finish the tutorial before creating a guild.');

        // Ensure the player has enough gold to create a guild.
        if (!player.inventory.hasItem('gold', 30_000))
            return player.guildNotify('You need 30,000 gold in your inventory to create a guild.');

        /**
         * We use the lower case of the guild name as the identifier. That way
         * we allow players to have guilds with capital letters in their name.
         */

        let identifier = name.toLowerCase();

        this.database.loader.loadGuild(identifier, (guild?: GuildData) => {
            // Ensure a guild doesn't already exist with that name.
            if (guild) return player.guildNotify('A guild with that name already exists.');

            // Remove the gold from the player's inventory.
            player.inventory.removeItem('gold', 30_000);

            let data: GuildData = {
                identifier,
                name,
                creationDate: Date.now(),
                inviteOnly: false,
                experience: 0,
                owner: player.username,
                members: [
                    {
                        username: player.username,
                        rank: Modules.GuildRank.Landlord,
                        joinDate: Date.now()
                    }
                ],
                decoration: {
                    banner,
                    outline,
                    outlineColour,
                    crest
                }
            };

            this.database.creator.saveGuild(data);

            // Send the join packet to the player.
            player.send(
                new GuildPacket(Opcodes.Guild.Login, {
                    name,
                    owner: player.username,
                    members: data.members,
                    decoration: data.decoration
                })
            );

            // Assign the guild identifier to the player.
            player.guild = identifier;

            // Save the player
            player.save();
        });
    }

    /**
     * Connects a player with their guild. In the case of a login, we want to
     * load the guild from the database, assign it to the player, and send a packet
     * to the client to connect them to the guild (update the user interface).
     * Additionally, we want to send a packet to all the members of the guild to
     * update their member list.
     * @param player The player that is logging in.
     * @param identifier The string identifier of the guild (to load from the database).
     */

    public connect(player: Player, identifier: string): void {
        // Attempt to grab the guild from the database.
        this.database.loader.loadGuild(identifier, (guild?: GuildData) => {
            if (!guild) {
                // Erase the guild identifier from the player.
                player.guild = '';
                return;
            }

            // Remove the player if they are not in the guild.
            if (!guild.members.some((member) => member.username === player.username)) {
                player.guild = '';
                return;
            }

            // Send the join packet to the player.
            player.send(
                new GuildPacket(Opcodes.Guild.Login, {
                    name: guild.name,
                    owner: guild.owner,
                    members: guild.members,
                    decoration: guild.decoration
                })
            );

            // Synchronize the connection with all the members in the guild.
            this.updateStatus(player, guild.members);
        });
    }

    /**
     * Adds a member to a specified guild and synchronizes the member list among
     * all the players in the guild.
     * @param player The player that is joining the guild.
     * @param identifier Used to determine the guild the player is joining.
     */

    public join(player: Player, identifier: string): void {
        if (player.isGuest) return player.notify('Guests are not allowed to join a guild.');

        if (player.guild) return player.notify('You are already in a guild.');

        // Attempt to grab the guild from the database.
        this.database.loader.loadGuild(identifier, (guild?: GuildData) => {
            if (!guild)
                return log.general(
                    `Player ${player.username} tried to join a guild that doesn't exist.`
                );

            // Ensure the guild isn't full.
            if (guild.members.length >= Modules.Constants.MAX_GUILD_MEMBERS)
                return player.notify('This guild is already at maximum capacity.');

            // Append the player to the guild's member list.
            guild.members.push({
                username: player.username,
                rank: Modules.GuildRank.Fledgling,
                joinDate: Date.now()
            });

            // Save the guild to the database.
            this.database.creator.saveGuild(guild, () => {
                // Set the guild identifier on the player.
                player.guild = identifier;

                // Save the player.
                player.save();

                // Connect the player to the guild.
                this.connect(player, identifier);

                // Send the join packet to the player.
                player.send(
                    new GuildPacket(Opcodes.Guild.Login, {
                        name: guild.name,
                        owner: guild.owner,
                        members: guild.members,
                        decoration: guild.decoration
                    })
                );

                // Sync to all the members in the guild.
                this.synchronize(guild.members, Opcodes.Guild.Join, {
                    username: player.username,
                    serverId: config.serverId
                });
            });
        });
    }

    /**
     * Handles a player leaving the guild. We want to update the guild in the database
     * and relay that information to all the members currently in the guild.
     * @param player The player that is leaving the guild.
     */

    public leave(player: Player): void {
        // No need to do anything if the player doesn't have a guild.
        if (!player.guild)
            return log.warning(`${player.username} tried to leave a guild that they're not in.`);

        // Grab the guild from the database.
        this.database.loader.loadGuild(player.guild, (guild?: GuildData) => {
            if (!guild)
                return log.general(
                    `Player ${player.username} tried to leave a guild that doesn't exist.`
                );

            // Disband the guild if the player is the owner.
            if (player.username === guild.owner) {
                // Send the leave packet to all the members in the guild.
                this.synchronize(guild.members, Opcodes.Guild.Leave);

                // Disband the guild
                this.database.deleteGuild(player.guild);

                // Remove the guild identifier from the player.
                player.guild = '';

                return;
            }

            // Remove the player from the guild's member list.
            guild.members = guild.members.filter((member) => member.username !== player.username);

            // Save the guild to the database.
            this.database.creator.saveGuild(guild);

            // Remove the guild object from the player.
            player.guild = '';

            // Send the leave packet to the player.
            player.send(new GuildPacket(Opcodes.Guild.Leave));

            // Sync to all the members in the guild.
            this.synchronize(guild.members, Opcodes.Guild.Leave, {
                username: player.username
            });
        });
    }

    /**
     * Kicks a player from the guild based on the username. Kicking works similarly to
     * leaving a guild, except that the player is leaving without their consent.
     * @param player The player that is kicking someone from the guild.
     * @param username The username of the player that is being kicked.
     */

    public kick(player: Player, username: string): void {
        if (!player.guild)
            return log.warning(
                `${player.username} tried to kick someone from a guild that they're not in.`
            );

        // Grab the guild from the database.
        this.database.loader.loadGuild(player.guild, (guild?: GuildData) => {
            if (!guild)
                return log.general(
                    `Player ${player.username} tried to kick someone from a guild that doesn't exist.`
                );

            // Ensure the player is the owner of the guild.
            if (player.username !== guild.owner)
                return player.notify('You do not have permission to kick members from this guild.');

            // Ensure the player is not kicking themselves.
            if (player.username === username)
                return player.notify('You cannot kick yourself from the guild.');

            let otherPlayer = this.world.getPlayerByName(username);

            // Remove the guild from the player being kicked if they're online.
            if (otherPlayer) otherPlayer.guild = '';

            // Sync to all the members in the guild.
            this.synchronize(guild.members, Opcodes.Guild.Leave, {
                username
            });

            // Remove the player from the guild's member list.
            guild.members = guild.members.filter((member) => member.username !== username);

            // Save the guild to the database.
            this.database.creator.saveGuild(guild);
        });
    }

    /**
     * Handles relaying a chat packet to all the members in the guild.
     * @param player The player that is sending the chat message.
     * @param message The message that the player is sending.
     */

    public chat(player: Player, message: string): void {
        if (!player.guild)
            return log.warning(`${player.username} tried to chat in a guild that they're not in.`);

        this.database.loader.loadGuild(player.guild, (guild?: GuildData) => {
            if (!guild)
                return log.general(
                    `Player ${player.username} tried to chat in a guild that doesn't exist.`
                );

            this.synchronize(guild.members, Opcodes.Guild.Chat, {
                username: player.username,
                serverId: config.serverId,
                message
            });
        });
    }

    /**
     * Adds an experience to a guild and relays the information to all the members
     * in the guild.
     * @param player The player that is adding the experience.
     * @param experience The amount of experience that is being added.
     */

    public addExperience(player: Player, experience: number): void {
        if (!player.guild)
            return log.warning(
                `${player.username} tried to add experience to a guild that they're not in.`
            );

        this.database.loader.loadGuild(player.guild, (guild?: GuildData) => {
            if (!guild)
                return log.general(
                    `Player ${player.username} tried to add experience to a guild that doesn't exist.`
                );

            guild.experience += experience;

            this.database.creator.saveGuild(guild);

            this.synchronize(guild.members, Opcodes.Guild.Experience, {
                experience: guild.experience
            });
        });
    }

    /**
     * Updates the rank of a player in the guild and relays the information to all
     * the members in the guild.
     * @param player The player that is updating the rank.
     * @param username The username of the player that is having their rank updated.
     * @param rank The rank that the player is being updated to.
     */

    public setRank(player: Player, username: string, rank: Modules.GuildRank): void {
        if (!player.guild)
            return log.warning(
                `${player.username} tried to set a rank in a guild that they're not in.`
            );

        this.database.loader.loadGuild(player.guild, (guild?: GuildData) => {
            if (!guild)
                return log.general(
                    `Player ${player.username} tried to set a rank in a guild that doesn't exist.`
                );

            // Ensure the player has the correct permissions to update the rank.
            if (player.username !== guild.owner)
                return player.notify(
                    'You do not have permission to update the rank of this player.'
                );

            // Iterate through the members and skip if the username doesn't match.
            for (let member of guild.members) {
                if (member.username !== username) continue;

                // Update the rank of the member.
                member.rank = rank;
            }

            this.database.creator.saveGuild(guild);

            this.synchronize(guild.members, Opcodes.Guild.Rank, {
                username,
                rank
            });
        });
    }

    /**
     * Iterates through the members in the world that are active in the guild and
     * sends a packet. The remaining members are relayed through the hub.
     * @param members The members in the group that we are sending packets to.
     * @param opcode The opcode of the packet that we are sending.
     * @param data The data that we are sending to the client.
     */

    private synchronize(
        members: Member[],
        opcode: Opcodes.Guild,
        data?: OutgoingGuildPacket
    ): void {
        for (let member of members) {
            let player = this.world.getPlayerByName(member.username),
                packet = new GuildPacket(opcode, data);

            // Attempt to relay the packet across servers.
            if (!player) {
                this.world.client.relay(member.username, packet);
                continue;
            }

            player.send(packet);
        }
    }

    /**
     * Verifies the online status of other members in the guild and sends a packet
     * to the hub to check against other servers.
     * @param player The player who wants to check the online status of other members.
     * @param members List of members in the guild.
     */

    private updateStatus(player: Player, members: Member[]): void {
        // Update the online players in the world and then request hub to check for online players.
        let offlineMembers: string[] = [],
            onlineMembers: Member[] = [];

        // Iterate through the guild's members and check if they are online.
        for (let member of members)
            if (this.world.isOnline(member.username))
                onlineMembers.push({
                    username: member.username,
                    serverId: config.serverId
                });
            else offlineMembers.push(member.username);

        // Send the online members to the player's client.
        player.send(new GuildPacket(Opcodes.Guild.Update, { members: onlineMembers }));

        // Send the offline members to the hub to check against the online players.
        this.world.client.send(
            new GuildPacket(Opcodes.Guild.Update, {
                username: player.username,
                usernames: offlineMembers
            })
        );
    }

    /**
     * Grabs a list of guilds from the database based on the specified range. We
     * extract only the information that we need and send it to the player.
     * @param player The player that is requesting the list.
     * @param from The index at which we start grabbing guilds.
     * @param to The index at which we stop grabbing guilds.
     */

    public get(player: Player, from: number, to: number): void {
        this.database.loader.loadGuilds(from, to, (info: GuildData[], total: number) => {
            // Filter guild data that are full and/or invite only.
            info = info.filter(
                (guild: GuildData) =>
                    guild.members.length < Modules.Constants.MAX_GUILD_MEMBERS && !guild.inviteOnly
            );

            // Extract the cruical information and store it in a ListInfo array.
            let guilds: ListInfo[] = info.map((guild) => ({
                name: guild.name,
                members: guild.members.length,
                decoration: guild.decoration,
                inviteOnly: guild.inviteOnly
            }));

            player.send(new GuildPacket(Opcodes.Guild.List, { guilds, total }));
        });
    }
}
