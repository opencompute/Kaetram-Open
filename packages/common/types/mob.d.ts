export interface MobData {
    name: string;
    description?: string | string[];
    hitPoints?: number;
    drops?: { [itemKey: string]: number };
    dropTables?: string[];
    level?: number;
    health?: number;
    accuracy?: number;
    strength?: number;
    defense?: number;
    magic?: number;
    archery?: number;
    attackLevel?: number;
    attackStats?: Stats;
    defenseStats?: Stats;
    bonuses?: Bonuses;
    attackRange?: number;
    aggroRange?: number;
    aggressive?: boolean;
    alwaysAggressive?: boolean;
    attackRate?: number;
    respawnDelay?: number;
    movementSpeed?: number;
    poisonous?: boolean;
    freezing?: boolean;
    burning?: boolean;
    hiddenName?: boolean;
    projectileName?: string;
    roaming?: boolean;
    plugin?: string;
    achievement?: string;
    boss?: boolean;
    miniboss?: boolean;
    roamDistance?: number;
    healRate?: number;
}

export interface RawData {
    [key: string]: MobData;
}
