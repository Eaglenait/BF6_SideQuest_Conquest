import * as modlib from "modlib";

//////////////////////////////////////////////////////////////////////////////
////////////////////////////////// MODELS //////////////////////////////////
//////////////////////////////////////////////////////////////////////////////

enum QuestState_Enum {
    NotStarted,
    InProgress,
    Completed,
    Failed
}

/** Contextual variables necessary to update the quest */
interface QuestContext {
    eventPlayer?: mod.Player;
    eventSquad?: mod.Squad;
    eventTeam?: mod.Team;
    eventOtherPlayer?: mod.Player;
    eventDamageType?: mod.DamageType;
    eventDeathType?: mod.DeathType;
    eventWeaponUnlock?: mod.WeaponUnlock;
    progress?: QuestProgress;
    //need to be nullable to mark that it might be null before being enriched in the manager
    questInstance?: QuestInstance;
    updateSource?: QuestUpdateSource;
    perkInstance?: PerkInstance;
}

/** Base interface for progress of the quest instance */
class QuestProgress {
    current: number;
    target: number;
    state: QuestState_Enum = QuestState_Enum.NotStarted;

    get percent(): number {
        if (this.target <= 0) return 0;
        return Math.round(Math.min(1, this.current / this.target) * 100);
    }

    constructor (target: number = 1, current: number = 0) {
        this.target = target;
        this.current = current;
    }
}

/** Result of the quest update method */
interface QuestUpdateResult extends QuestProgress {
    nextState?: QuestState_Enum;
}
const defaultUpdateResult: QuestUpdateResult = { current: 0, target: 1, percent: 0, state: QuestState_Enum.NotStarted, nextState: QuestState_Enum.NotStarted};

/** Type to represent a method that applies a perk to a quest scope (player, squad, team) */
type PerkApply = (ctx: PerkContext) => void;

interface PerkContext extends QuestContext {
    targets?: mod.Player[];
}

interface PerkDefinition {
    name: string;
    description?: string;
    availableScopes: QuestScope[];
    randomWeight?: number;
    createInstance(questInstance: QuestInstance): PerkInstance;
}

interface PerkInstance {
    definition: PerkDefinition;
    apply: PerkApply;
}

/** Who can complete the quest. Also who wins the perk of the completion */
enum QuestScope {
    Squad,
    Player,
    Team,
    /** Everyone in the game has the quest */
    Game
}
const AllQuestScopes = [QuestScope.Squad, QuestScope.Player, QuestScope.Team];

const STR = mod.stringkeys;

/** 
 * From where the update() method of a quest definition should be called. 
 */
enum QuestUpdateSource {
    /** Periodic check */
    Timer,
    /** Whenever the players achieves a kill */
    OnPlayerEarnedKill,
    /** Whenever the player damages another player*/
    OnPlayerAchievesDamage,
    /** Whenever the player recieves damage without dying*/
    OnPlayerReceivesDamage,
    OnPlayerInteract,
    /** Whenever the player enters a specific zone */
    OnPlayerEnterZone,
    OnRevived,
}

  const BATTLEFIELD_GREY = [0.616, 0.635, 0.647];

enum QuestFailReason {
    TimeExpired,
    PlayerDied,
    PlayerLeftGame,
    OtherTeamAchievedFirst,
    PlayerReceivedDamage
}

/** Describes a quest to be completed by a squad, player or team */
class QuestDefinition {
    name: string = STR.empty ;
    description: string = STR.empty;
    availableScope: QuestScope[] = [];
    /** Weight for random selection, higher means more likely to be chosen */
    randomWeight?: number = 1; 
    updateSources: QuestUpdateSource[] = []; 

    /** 
     * Default value for the target of the quest progress object in the QuestInstance 
     * This essentially defines how much work is needed to complete the quest
     * For example if the quest is to achieve 10 kills with a pistol, this value should be 10
     * If the quest is to capture 3 zones, this value should be 3
     * If the quest is to interact with something once, this value should be 1
     */
    defaultTarget?: number = 1;

    /** Optional perk pool overriding the global registry when instantiating this quest. */
    perkPool?: PerkDefinition[];

    /** Disable automatic perk assignment when true. */
    disableRandomPerk?: boolean;

    /** To be called to update the quest state */
    update: (ctx: QuestContext) => QuestUpdateResult

    /** Optional; used to prepare state or emit UI when quest spawns. */
    onStart?: (ctx: QuestContext) => void;

    /** Optional; invoked once when quest completes (can grant rewards, notify UI, spawn next quest, etc.). */
    onComplete?: (ctx: QuestContext) => void;

    constructor() {
        this.update = (ctx: QuestContext) => { return defaultUpdateResult; };
    }
}

/** Instance of a currently ongoing quest */
class QuestInstance {
    private static nextId = 1;

    readonly id: number;
    readonly quest: QuestDefinition;
    readonly scope: QuestScope;
    perkInstance?: PerkInstance;

    player?: mod.Player;
    squad?: mod.Squad;
    team?: mod.Team;

    /** 
     * Stores data related to the progress of the quest. 
     * For example if you need to achieve 10 kills with a pistol, current will be the number of kills achieved so far. And target will be 10.
     */
    currentProgress: QuestProgress;

    constructor(def: QuestDefinition, scope: QuestScope, ctx: QuestContext) {
        this.id = QuestInstance.nextId++;
        this.quest = def;
        this.scope = scope;

        if (scope === QuestScope.Player) {
            this.player = ctx.eventPlayer;
        }

        if (scope === QuestScope.Squad) {
            this.squad = ctx.eventSquad;
        }

        if (scope === QuestScope.Team) {
            this.team = ctx.eventTeam;
        }

        this.currentProgress = new QuestProgress(def.defaultTarget ?? 1);
    }
}

class QuestManager {
    /** Every active quest available to players */
    private activeQuests: QuestInstance[] = [];

    /** Every completed quest */
    private pastQuests: QuestInstance[] = [];

    /** Shared quest for every player in the game */
    private activeGlobalQuest?: QuestInstance = undefined;

    constructor() {}

    init(initialQuests: { quest: QuestDefinition; scope: QuestScope; ctx: QuestContext }[] = []) {
        DebugMessage(STR.questManagerInitializing);
        this.activeQuests = [];
        this.pastQuests = [];
        this.activeGlobalQuest = undefined;

        for (const config of initialQuests) {
            this.registerQuest(config.quest, config.scope, config.ctx);
        }
    }

    registerQuest(questDef: QuestDefinition, scope: QuestScope, ctx: QuestContext): QuestInstance {
        const questInstance = new QuestInstance(questDef, scope, ctx);
        if (ctx.eventPlayer) {
            Log(STR.questManagerRegisterQuest, ctx.eventPlayer, questDef.name, QuestScope[scope], ctx.eventPlayer);
        }


        if (!questDef.disableRandomPerk) {
            const perkInstance = this.pickPerkForQuest(questInstance);
            if (perkInstance) {
                questInstance.perkInstance = perkInstance;
            }
        }

        if (scope === QuestScope.Game) {
            this.activeGlobalQuest = questInstance;
        } else {
            this.activeQuests.push(questInstance);
        }

        const startCtx: QuestContext = {
            ...ctx,
            questInstance,
            progress: questInstance.currentProgress,
            updateSource: undefined,
            perkInstance: questInstance.perkInstance
        };

        if (questDef.onStart) {
            try {
                questDef.onStart(startCtx);
            } catch (err) {
                if (startCtx.eventPlayer) {
                    Log(STR.questManagerOnStartError, startCtx.eventPlayer, questDef.name, err);
                }
            }
        }

        this.notifyQuestStart(questInstance);

        return questInstance;
    }

    unregisterQuest(questInstance: QuestInstance) {
        if (questInstance.scope === QuestScope.Game) {
            if (this.activeGlobalQuest?.id === questInstance.id) {
                this.activeGlobalQuest = undefined;
            }
            return;
        }

        this.activeQuests = this.activeQuests.filter(instance => instance.id !== questInstance.id);
    }

    resetPlayer(player: mod.Player) {
        Log(STR.questManagerResetPlayer, player, player);
        this.activeQuests = this.activeQuests.filter(instance => instance.player && mod.GetObjId(instance.player) !== mod.GetObjId(player));
    }

    playerJoined(player: mod.Player) {
        const team = mod.GetTeam(player);
        Log(STR.questManagerPlayerJoined, player, player, team);
    }

    updatePlayer(player: mod.Player, source: QuestUpdateSource, ctx: QuestContext): void {
        const enrichedCtx: QuestContext = {
            ...ctx,
            eventPlayer: ctx.eventPlayer ?? player,
            updateSource: source
        };

        const relevantQuests: QuestInstance[] = [];

        if (enrichedCtx.eventPlayer) {
            relevantQuests.push(...this.getPlayerQuests(enrichedCtx.eventPlayer));

            if (!enrichedCtx.eventTeam) {
                enrichedCtx.eventTeam = mod.GetTeam(enrichedCtx.eventPlayer);
            }
        }

        if (enrichedCtx.eventSquad) {
            relevantQuests.push(...this.getSquadQuests(enrichedCtx.eventSquad));
        }

        if (enrichedCtx.eventTeam) {
            relevantQuests.push(...this.getTeamQuests(enrichedCtx.eventTeam));
        }

        if (this.activeGlobalQuest) {
            relevantQuests.push(this.activeGlobalQuest);
        }

        if (relevantQuests.length === 0) {
            return;
        }

        for (const questInstance of relevantQuests) {
            if (!questInstance.quest.updateSources.includes(source)) {
                continue;
            }

            this.processQuestUpdate(questInstance, enrichedCtx);
        }
    }

    private processQuestUpdate(questInstance: QuestInstance, ctx: QuestContext) {
        const progress = questInstance.currentProgress;
        const quest = questInstance.quest;

        if (progress.state === QuestState_Enum.NotStarted) {
            progress.state = QuestState_Enum.InProgress;
        }

        const questCtx: QuestContext = {
            ...ctx,
            questInstance,
            progress,
            eventPlayer: ctx.eventPlayer ?? questInstance.player,
            eventSquad: ctx.eventSquad ?? questInstance.squad,
            eventTeam: ctx.eventTeam ?? questInstance.team,
            perkInstance: questInstance.perkInstance
        };

        if (questCtx.eventPlayer) {
            Log(STR.questManagerUpdatingQuest, questCtx.eventPlayer, quest.name, questInstance.id, questCtx.eventPlayer);
        }

        try {
            const previousCurrent = progress.current;
            const previousTarget = progress.target;
            const previousPercent = progress.percent;
            const previousState = progress.state;

            const result = quest.update(questCtx);

            if (result) {
                progress.current = result.current;
                progress.target = result.target;
                progress.state = result.state;
            }

            if (progress.current !== previousCurrent || progress.target !== previousTarget || progress.state !== previousState) {
                this.notifyQuestProgress(questInstance, questCtx, previousPercent, progress.percent);
            }

            if (result?.nextState === QuestState_Enum.Completed || progress.state === QuestState_Enum.Completed) {
                progress.state = QuestState_Enum.Completed;
                this.handleQuestCompletion(questInstance, questCtx);
            }
        } catch (err) {
            if (ctx.eventPlayer) {
                Log(STR.questManagerUpdateError, ctx.eventPlayer, quest.name, questInstance.id, err);
            }
        }
    }

    private handleQuestCompletion(questInstance: QuestInstance, ctx: QuestContext) {
        if (ctx.eventPlayer) {
            Log(STR.questManagerQuestCompleted, ctx.eventPlayer, questInstance.quest.name, questInstance.id);
        }

        if (questInstance.perkInstance) {
            const targets = playersMatchingQuest(questInstance);
            const recipients = targets.length > 0 ? targets : ctx.eventPlayer ? [ctx.eventPlayer] : [];
            const perkCtx: PerkContext = {
                ...ctx,
                questInstance,
                perkInstance: questInstance.perkInstance,
                targets: recipients
            };
            try {
                questInstance.perkInstance.apply(perkCtx);
            } catch (err: unknown) {
                if (perkCtx.eventPlayer) {
                    Log(STR.errors.perkApplyError, perkCtx.eventPlayer, perkCtx.perkInstance?.definition.name, perkCtx.eventPlayer, err);
                }
            }
        }

        this.unregisterQuest(questInstance);
        this.pastQuests.push(questInstance);

        this.notifyQuestCompletion(questInstance, ctx);

        if (questInstance.quest.onComplete) {
            try {
                questInstance.quest.onComplete(ctx);
            } catch (err) {
                if (ctx.eventPlayer) {
                    Log(STR.questManagerOnCompleteError, ctx.eventPlayer, questInstance.quest.name, err);
                }
            }
        }
    }

    private getPlayerQuests(player: mod.Player): QuestInstance[] {
        const pId = mod.GetObjId(player);
        return this.activeQuests.filter(quest => quest.player && mod.GetObjId(quest.player) === pId);
    }

    private getSquadQuests(squad: mod.Squad): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.squad === squad);
    }

    private getTeamQuests(team: mod.Team): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.team === team);
    }

    private pickPerkForQuest(questInstance: QuestInstance): PerkInstance | undefined {
        const pool = questInstance.quest.perkPool ?? PerkRegistry;
        if (!pool || pool.length === 0) {
            return undefined;
        }

        const eligible = pool.filter((def: PerkDefinition) => def.availableScopes.includes(questInstance.scope));
        if (eligible.length === 0) {
            return undefined;
        }

        const selected = pickWeightedPerk(eligible);
        return selected.createInstance(questInstance);
    }

    private notifyQuestStart(questInstance: QuestInstance) {
        // Refresh UI for all players impacted by this quest start
        try {
            RefreshUIForQuestScope(questInstance);
        } catch { }
    }

    private notifyQuestProgress(questInstance: QuestInstance, ctx: QuestContext, previousPercent: number, nextPercent: number) {
        if (nextPercent === previousPercent) {
            return;
        }

        const clampedPercent = Math.min(100, Math.max(0, Math.round(nextPercent)));
        if (ctx.eventPlayer) {
            Log(STR.questProgressNotification, ctx.eventPlayer, questInstance.quest.name, clampedPercent);
        }

        // Update UI for all players impacted by this quest
        try {
            RefreshUIForQuestScope(questInstance);
        } catch { }
    }

    private notifyQuestCompletion(questInstance: QuestInstance, ctx: QuestContext) {
        if (ctx.eventPlayer) {
            Log(STR.questCompletedNotification, ctx.eventPlayer, questInstance.quest.name);
        }

        // Update UI for all players that were seeing this quest
        try { 
            RefreshUIForQuestScope(questInstance); 
        } catch { }
    }

    getPlayerQuest(player: mod.Player): QuestInstance | undefined {
        const pid = mod.GetObjId(player);
        if (pid < 0) return undefined;
        return this.activeQuests.find(q => q.scope === QuestScope.Player && q.player && mod.GetObjId(q.player) === pid);
    }

    getSquadQuest(squad: mod.Squad): QuestInstance | undefined {
        return this.activeQuests.find(q => q.scope === QuestScope.Squad && q.squad === squad);
    }

    getTeamQuest(team: mod.Team): QuestInstance | undefined {
        return this.activeQuests.find(q => q.scope === QuestScope.Team && q.team === team);
    }

    getGlobalQuest(): QuestInstance | undefined {
        return this.activeGlobalQuest;
    }

    hasPlayerQuest(player: mod.Player): boolean {
        return !!this.getPlayerQuest(player);
    }
}

type PlayerQuestUI = {
    root: mod.UIWidget;
    header: mod.UIWidget;
    title: mod.UIWidget;
    description: mod.UIWidget;
    progress: mod.UIWidget;
};

///////////////////////////////// MODEL END //////////////////////////////////


//////////////////////////////////////////////////////////////////////////////
///////////////////////// Game Variables Data ////////////////////////////////
//////////////////////////////////////////////////////////////////////////////

//ALL QUESTS DEFINITIONS
const firstBlood_Quest: QuestDefinition = {
    name: STR.quests.firstBloodQuest.name,
    description: STR.quests.firstBloodQuest.description,
    availableScope: [QuestScope.Game],
    updateSources: [QuestUpdateSource.OnPlayerEarnedKill],
    update: (ctx: QuestContext) => {
        if (!ctx.questInstance) {
            Log(STR.errors.questInstanceError, ctx.eventPlayer);
            return defaultUpdateResult;
        }

        const progress = ctx.questInstance.currentProgress;
        progress.current = progress.target;
        progress.state = QuestState_Enum.Completed;

        return {
            current: progress.current,
            target: progress.target,
            state: progress.state,
            nextState: QuestState_Enum.Completed,
            percent: progress.percent
        };
    },
    onComplete: (ctx: QuestContext) => {
        // DebugMessage(STR.debug.applyPerk, ctx.questInstance?.perkInstance?.definition.name, ctx.eventPlayer);
        Log(STR.debug.applyPerk, ctx.eventPlayer, ctx.questInstance?.perkInstance?.definition.name, ctx.eventPlayer);
        ctx.questInstance?.perkInstance?.apply(ctx);
    },
};

const pistolKills_Quest: QuestDefinition = {
    name: STR.quests.pistolKillsQuest.name,
    description: STR.quests.pistolKillsQuest.description,
    availableScope: AllQuestScopes,
    defaultTarget: 10,
    updateSources: [QuestUpdateSource.OnPlayerEarnedKill],
    update: (ctx: QuestContext) => {
        Log(STR.debug.pistolKillsQuestDebug, ctx.eventPlayer, ctx.eventWeaponUnlock);
        DebugMessage(STR.debug.pistolKillsQuestDebug, ctx.eventWeaponUnlock);
        if (!ctx.questInstance) {
            return defaultUpdateResult;
        }

        const progress = ctx.questInstance.currentProgress;

        if (progress.state === QuestState_Enum.Completed) {
            return toQuestUpdateResult(progress, QuestState_Enum.Completed);
        }

        if (!isPistolWeapon(ctx.eventWeaponUnlock)) {
            return toQuestUpdateResult(progress);
        }

        progress.current = Math.min(progress.target, progress.current + 1);

        const completed = progress.current >= progress.target;
        if (completed) {
            progress.state = QuestState_Enum.Completed;
        }

        return toQuestUpdateResult(progress, completed ? QuestState_Enum.Completed : undefined);
    },
    onComplete: (ctx: QuestContext) => {
        Log(STR.playerWelcomeMessage, ctx.eventPlayer);
    }
};
//END - ALL QUESTS DEFINITIONS

//ALL PERKS DEFINITIONS
const SpeedBoostPerkDefinition: PerkDefinition = {
    name: STR.perks.speedBoost.name,
    description: STR.perks.speedBoost.description,
    availableScopes: AllQuestScopes,
    randomWeight: 1,
    createInstance: (questInstance: QuestInstance): PerkInstance => ({
        definition: SpeedBoostPerkDefinition,
        apply: async (ctx: PerkContext) => {
            const initialTargets = ctx.targets ?? playersMatchingQuest(questInstance);
            const recipients = initialTargets.length > 0 ? initialTargets : ctx.eventPlayer ? [ctx.eventPlayer] : [];
            if (recipients.length === 0) {
                return;
            }

            for (const target of recipients) {
                void applyTemporarySpeedMultiplier(target, 1.5, 20);
            }
        }
    })
};

//END - ALL PERKS DEFINITIONS

/** All available perks */
const PerkRegistry: PerkDefinition[] = [
    SpeedBoostPerkDefinition
];

/** All available quests */
var QuestRegistry: QuestDefinition[] = [
    firstBlood_Quest,
    pistolKills_Quest
];

var q_manager = new QuestManager();

const g_playerUIs: { [playerId: number]: PlayerQuestUI } = {};
const g_activePlayers: mod.Player[] = [];
let g_uiUniqueCounter = 1;

const PLAYER_UI_OFFSET_X = 48;
const PLAYER_UI_OFFSET_Y = 120;
const PLAYER_UI_WIDTH = 420;
const PLAYER_UI_HEIGHT = 128;
const PLAYER_UI_LINE_HEIGHT = 24;

///////////////////////////////// GAME VARIABLE DATA END //////////////////////////////////


///////////////////////////////////////////////////////////////////////////////////
///////////////////////////////// GAME FUNCTIONS //////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////

/** Get all players matching the quest instance's scope */
function playersMatchingQuest(questInstance: QuestInstance): mod.Player[] {
    const players: mod.Player[] = [];
    if (questInstance.scope === QuestScope.Game) {
        return [...g_activePlayers];
    }
    if (questInstance.scope === QuestScope.Player && questInstance.player) {
        const pid = mod.GetObjId(questInstance.player);
        const p = g_activePlayers.find(x => mod.GetObjId(x) === pid);
        return p ? [p] : [];
    }
    if (questInstance.scope === QuestScope.Team && questInstance.team) {
        for (const p of g_activePlayers) {
            if (mod.GetTeam(p) === questInstance.team) players.push(p);
        }
        return players;
    }
    if (questInstance.scope === QuestScope.Squad && questInstance.squad) {
        const getSquad = (mod as any).GetSquad as undefined | ((pl: mod.Player) => mod.Squad);
        if (!getSquad) return players; // unknown API; nothing to do
        for (const p of g_activePlayers) {
            if (getSquad(p) === questInstance.squad) players.push(p);
        }
        return players;
    }
    return players;
}

/** Assign a random quest to the player */
function assignRandomQuestToPlayer(player: mod.Player) {
    if (!player || q_manager.hasPlayerQuest(player) || isPlayerAi(player)) {
        return;
    }

    const quest = pickRandomQuestForScope(QuestScope.Player);
    if (!quest) {
        return;
    }

    q_manager.registerQuest(quest, QuestScope.Player, { eventPlayer: player });
}

//** Checks if the passed weapon is a pistol */
function isPistolWeapon(weapon?: mod.WeaponUnlock): boolean {
    if (!weapon) {
        return false;
    }

    const weaponName = String(weapon);
    return weaponName.startsWith("Sidearm_");
}


function ensurePlayerTracked(player: mod.Player) {
    const id = mod.GetObjId(player);
    if (id < 0) return;
    if (!g_activePlayers.some(p => mod.GetObjId(p) === id)) {
        g_activePlayers.push(player);
    }
}

function pickWeightedPerk(definitions: PerkDefinition[]): PerkDefinition {
    const totalWeight = definitions.reduce((sum, def) => sum + (def.randomWeight ?? 1), 0);
    let roll = Math.random() * (totalWeight <= 0 ? 1 : totalWeight);
    for (const def of definitions) {
        roll -= def.randomWeight ?? 1;
        if (roll <= 0) {
            return def;
        }
    }
    return definitions[definitions.length - 1];
}


//--to review
const g_playerSpeedTokens: { [playerId: number]: number } = {};
let g_nextSpeedToken = 1;
async function applyTemporarySpeedMultiplier(player: mod.Player, multiplier: number, durationSeconds: number): Promise<void> {
    if (!player) {
        return;
    }

    const playerId = mod.GetObjId(player);
    if (playerId < 0) {
        return;
    }

    const token = g_nextSpeedToken++;
    g_playerSpeedTokens[playerId] = token;
    mod.SetPlayerMovementSpeedMultiplier(player, multiplier);

    if (durationSeconds <= 0) {
        return;
    }

    await mod.Wait(durationSeconds);

    if (g_playerSpeedTokens[playerId] === token) {
        mod.SetPlayerMovementSpeedMultiplier(player, 1);
        delete g_playerSpeedTokens[playerId];
    }
}

///////////////////////////////// GAME FUNCTIONS END //////////////////////////////////


////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////// GAME HOOKS //////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

// Triggered when player joins the game
export async function OnPlayerJoinGame(eventPlayer: mod.Player): Promise<void> {
    ensurePlayerTracked(eventPlayer);
}

// Triggered when player leaves the game
export async function OnPlayerLeaveGame(eventNumber: number): Promise<void> {
    // eventNumber is player ObjId per BF Portal convention
    const idx = g_activePlayers.findIndex(p => mod.GetObjId(p) === eventNumber);
    if (idx !== -1) {
        const player = g_activePlayers[idx];
        hidePlayerQuestUI(player);
        g_activePlayers.splice(idx, 1);
        delete g_playerUIs[eventNumber];
    }
}

// Triggered when player selects their class and deploys into game
export async function OnPlayerDeployed(eventPlayer: mod.Player): Promise<void> {
    Log(STR.gameManagerPlayerDeployedLog, eventPlayer);
    ensurePlayerTracked(eventPlayer);
    if (!isPlayerAi(eventPlayer)) {
        ensurePlayerQuestUI(eventPlayer);
    }
    assignRandomQuestToPlayer(eventPlayer);
    refreshUIForPlayer(eventPlayer);
}

// Triggered on player death/kill, returns dying player, the killer, etc. Useful for updating scores, updating progression, handling any death/kill related logic.
export async function OnPlayerDied(eventPlayer: mod.Player, eventOtherPlayer: mod.Player, eventDeathType: mod.DeathType, eventWeaponUnlock: mod.WeaponUnlock): Promise<void> {
}

export async function OnPlayerEarnedKill(
    eventPlayer: mod.Player,
    eventOtherPlayer: mod.Player,
    eventDeathType: mod.DeathType,
    eventWeaponUnlock: mod.WeaponUnlock
): Promise<void> {
    Log(STR.debug.onPlayerEarnedKill, eventPlayer);
    Log(STR.debug.onPlayerEarnedKill, eventOtherPlayer);
    try {
        const ctx: QuestContext = {
            eventPlayer,
            eventOtherPlayer,
            eventDeathType,
            eventWeaponUnlock
        };
        q_manager.updatePlayer(eventPlayer, QuestUpdateSource.OnPlayerEarnedKill, ctx);
    }
    catch (err) {
        Log(STR.gameManagerKillUpdateError, eventPlayer, eventPlayer, err);
    }
}

// Triggered when a player is damaged, returns same variables as OnPlayerDied. 
export async function OnPlayerDamaged(
    eventPlayer: mod.Player,
    eventOtherPlayer: mod.Player,
    eventDamageType: mod.DamageType,
    eventWeaponUnlock: mod.WeaponUnlock
): Promise<void> {
    const ctx: QuestContext = {
        eventPlayer,
        eventOtherPlayer,
        eventDamageType,
        eventWeaponUnlock
    };

    Log(STR.debug.playerDamageTest, eventPlayer, eventOtherPlayer, eventDamageType);

    try {
        q_manager.updatePlayer(eventPlayer, QuestUpdateSource.OnPlayerReceivesDamage, ctx);
    } catch (err) {
        Log(STR.errors.gameManager.damageUpdateError, eventPlayer, eventPlayer, err);
    }
}

// Triggered when a player interacts with InteractPoint. Reference by using 'mod.GetObjId(InteractPoint);'.
// Useful for any custom logic on player interaction such as updating check point, open custom UI, etc.
// Note that InteractPoint has to be placed in Godot scene and assigned an ObjId for reference.
export async function OnPlayerInteract(eventPlayer: mod.Player, eventInteractPoint: mod.InteractPoint): Promise<void> {}

// Triggered when a player enters/leaves referenced BF6 capture point. Useful for tracking capture point activities and overlapping players.
// Note that CapturePoint has to be placed in Godot scene, assigned an ObjId and a CapturePointArea(volume).
export async function OnPlayerEnterCapturePoint(eventPlayer: mod.Player, eventCapturePoint: mod.CapturePoint): Promise<void> {}
export async function OnPlayerExitCapturePoint(eventPlayer: mod.Player, eventCapturePoint: mod.CapturePoint): Promise<void> {}

// Triggered when a player enters/leaves referenced AreaTrigger volume. Useful for creating custom OnOverlap logic, creating custom capture point, etc.
// Note that AreaTrigger has to be placed in Godot scene, assigned an ObjId and a CollisionPolygon3D(volume).
export async function OnPlayerEnterAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): Promise<void> {}
export async function OnPlayerExitAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): Promise<void> {}

export async function OnPlayerSwitchTeam(eventPlayer: mod.Player, eventTeam: mod.Team): Promise<void> {
}

export async function OnGameModeEnding(): Promise<void> {}

export async function OngoingGlobal(): Promise<void> {
}

// Triggered on main gamemode start/end. Useful for game start setup and cleanup.
export async function OnGameModeStarted(): Promise<void> {
    mod.EnableHQ(mod.GetHQ(0), true);
    mod.EnableHQ(mod.GetHQ(1), true);
    
    // mod.AllCapturePoints
    mod.SetGameModeTargetScore(1000);
    mod.SetGameModeTimeLimit(20 * 60); 

    mod.SetSpawnMode(mod.SpawnModes.Deploy);
    mod.AllObjectsOfType()

    //todo replicate scoreboard
    // todo replicate capture points ui and top team points bar 
    // todo set map mode to replicate conquest

    let currentMap = null;
    for (const map of Object.values(mod.Maps)) {
        // Ensure map is of type Maps before calling IsCurrentMap
        if (typeof map !== "string" && mod.IsCurrentMap(map)) {
            currentMap = map;
            break;
        }
    }

    // No player context available for map announcement; skipping log.

    const cps = ConvertArray(mod.AllCapturePoints()) as mod.CapturePoint[];
    for (const cp of cps) {
        mod.EnableCapturePointDeploying(cp, true);
        mod.EnableGameModeObjective(cp, true);
    }

    // Adds X delay in seconds. Useful for making sure that everything has been initialized before running logic or delaying triggers.
    await mod.Wait(1);

    q_manager.init([
        { quest: QuestRegistry[0], scope: QuestScope.Game, ctx: {} }
    ]);

    for (const player of g_activePlayers) {
        assignRandomQuestToPlayer(player);
    }

    // Initialize quest UI for any already tracked players (if any)
    try { refreshUIForAllPlayers(); } catch {}
}
/////////////////////// GAME HOOKS END //////////////////////////////


//////////////////////////////////////////////////////////
/////////////////////// LIB //////////////////////////////
//////////////////////////////////////////////////////////

function isPlayerAi(player: mod.Player): boolean {
    return mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier) == true;
}

function ConvertArray(array: mod.Array): any[] {
    let v = [];
    let n = mod.CountOf(array);
    for (let i = 0; i < n; i++) {
        let currentElement = mod.ValueInArray(array, i);
        v.push(currentElement);
    }
    return v;
}

function MakeMessage(message: string, ...args: any[]) {
    switch (args.length) {
        default:
        case 0:
            return mod.Message(message);
        case 1:
            return mod.Message(message, args[0]);
        case 2:
            return mod.Message(message, args[0], args[1]);
        case 3:
            return mod.Message(message, args[0], args[1], args[2]);
    }
}

function DebugMessage(message: string, ...args: any[]) {
    const formattedMessage = MakeMessage(message, ...args);
    mod.DisplayHighlightedWorldLogMessage(formattedMessage);
}

function Log(message: string, player: mod.Player | undefined, ...args: any[]) {
    const formattedMessage = MakeMessage(message, ...args);
    if (player)
        mod.DisplayHighlightedWorldLogMessage(formattedMessage, player);
}

export function getPlayersInTeam(team: mod.Team) {
    const allPlayers = mod.AllPlayers();
    const n = mod.CountOf(allPlayers);
    let teamMembers = [];

    for (let i = 0; i < n; i++) {
        let player = mod.ValueInArray(allPlayers, i) as mod.Player;
        if (mod.GetTeam(player) == team) {
            teamMembers.push(player);
        }
    }
    return teamMembers;
}

function toQuestUpdateResult(progress: QuestProgress, nextState?: QuestState_Enum): QuestUpdateResult {
    return {
        current: progress.current,
        target: progress.target,
        state: progress.state,
        percent: progress.percent,
        nextState
    };
}


/////////////////////// UI: Player Quest Panel //////////////////////////////



function nextUiName(): string {
    return "sq_ui_" + (g_uiUniqueCounter++);
}


function ensurePlayerQuestUI(player: mod.Player): PlayerQuestUI | undefined {
    const id = mod.GetObjId(player);
    if (id < 0) return undefined;

    const existing = g_playerUIs[id];
    if (existing) return existing;

    const rootName = nextUiName();
    const headerName = nextUiName();
    const titleName = nextUiName();
    const descriptionName = nextUiName();
    const progressName = nextUiName();

    modlib.ParseUI({
        type: "Container",
        name: rootName,
        position: [-PLAYER_UI_OFFSET_X, PLAYER_UI_OFFSET_Y, 0],
        size: [PLAYER_UI_WIDTH, PLAYER_UI_HEIGHT, 0],
        anchor: mod.UIAnchor.TopRight,
        playerId: player,
        padding: 10,
        bgFill: mod.UIBgFill.Blur,
        bgColor: BATTLEFIELD_GREY,
        bgAlpha: 0.7,
        visible: false,
        children: [
            {
                type: "Text",
                name: headerName,
                position: [0, 0, 0],
                size: [PLAYER_UI_WIDTH - 20, PLAYER_UI_LINE_HEIGHT, 0],
                anchor: mod.UIAnchor.TopRight,
                textAnchor: mod.UIAnchor.CenterRight,
                textSize: 22,
                textColor: [1, 1, 1],
                textLabel: MakeMessage(STR.empty),
                bgAlpha: 0,
                visible: false,
            },
            {
                type: "Text",
                name: titleName,
                position: [0, PLAYER_UI_LINE_HEIGHT + 4, 0],
                size: [PLAYER_UI_WIDTH - 20, PLAYER_UI_LINE_HEIGHT + 2, 0],
                anchor: mod.UIAnchor.TopRight,
                textAnchor: mod.UIAnchor.CenterRight,
                textSize: 20,
                textColor: [0.95, 0.97, 1],
                textLabel: MakeMessage(STR.empty),
                bgAlpha: 0,
                visible: false,
            },
            {
                type: "Text",
                name: descriptionName,
                position: [0, (PLAYER_UI_LINE_HEIGHT + 4) * 2, 0],
                size: [PLAYER_UI_WIDTH - 20, PLAYER_UI_LINE_HEIGHT * 2, 0],
                anchor: mod.UIAnchor.TopRight,
                textAnchor: mod.UIAnchor.TopRight,
                textSize: 18,
                textColor: [0.85, 0.9, 1],
                textLabel: MakeMessage(STR.empty),
                bgAlpha: 0,
                visible: false,
            },
            {
                type: "Text",
                name: progressName,
                position: [0, (PLAYER_UI_LINE_HEIGHT + 4) * 3.1, 0],
                size: [PLAYER_UI_WIDTH - 20, PLAYER_UI_LINE_HEIGHT, 0],
                anchor: mod.UIAnchor.TopRight,
                textAnchor: mod.UIAnchor.CenterRight,
                textSize: 18,
                textColor: [0.75, 0.85, 1],
                textLabel: MakeMessage(STR.empty),
                bgAlpha: 0,
                visible: false,
            },
        ],
    });

    const root = mod.FindUIWidgetWithName(rootName) as mod.UIWidget;
    const header = mod.FindUIWidgetWithName(headerName) as mod.UIWidget;
    const title = mod.FindUIWidgetWithName(titleName) as mod.UIWidget;
    const description = mod.FindUIWidgetWithName(descriptionName) as mod.UIWidget;
    const progress = mod.FindUIWidgetWithName(progressName) as mod.UIWidget;

    mod.SetUIWidgetDepth(root, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetDepth(header, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetDepth(title, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetDepth(description, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetDepth(progress, mod.UIDepth.AboveGameUI);

    const ui: PlayerQuestUI = { root, header, title, description, progress };
    g_playerUIs[id] = ui;
    return ui;
}

function hidePlayerQuestUI(player: mod.Player) {
    const id = mod.GetObjId(player);
    const ui = g_playerUIs[id];
    if (!ui) return;
    mod.SetUIWidgetVisible(ui.root, false);
    mod.SetUIWidgetVisible(ui.header, false);
    mod.SetUIWidgetVisible(ui.title, false);
    mod.SetUIWidgetVisible(ui.description, false);
    mod.SetUIWidgetVisible(ui.progress, false);
}

function refreshUIForPlayer(player: mod.Player) {
    if (isPlayerAi(player)) return;

    const id = mod.GetObjId(player);
    if (id < 0) return;

    const ui = ensurePlayerQuestUI(player);
    if (!ui) return;

    const quest = q_manager.getPlayerQuest(player);
    if (!quest) {
        hidePlayerQuestUI(player);
        return;
    }

    const progress = quest.currentProgress ?? new QuestProgress(quest.quest.defaultTarget ?? 1);

    mod.SetUITextLabel(ui.header, MakeMessage(STR.selfQuestTitle));
    mod.SetUITextLabel(ui.title, MakeMessage(quest.quest.name));
    mod.SetUITextLabel(ui.description, MakeMessage(quest.quest.description));
    mod.SetUITextLabel(ui.progress, MakeMessage(STR.progress, progress.current, progress.target, progress.percent));

    mod.SetUIWidgetVisible(ui.root, true);
    mod.SetUIWidgetVisible(ui.header, true);
    mod.SetUIWidgetVisible(ui.title, true);
    mod.SetUIWidgetVisible(ui.description, true);
    mod.SetUIWidgetVisible(ui.progress, true);
}

function pickRandomQuestForScope(scope: QuestScope): QuestDefinition | undefined {
    const eligible = QuestRegistry.filter(def => def.availableScope.includes(scope));
    if (eligible.length === 0) {
        return undefined;
    }

    const totalWeight = eligible.reduce((sum, def) => sum + (def.randomWeight ?? 1), 0);
    let roll = Math.random() * (totalWeight > 0 ? totalWeight : 1);

    for (const def of eligible) {
        roll -= def.randomWeight ?? 1;
        if (roll <= 0) {
            return def;
        }
    }

    return eligible[eligible.length - 1];
}

function refreshUIForAllPlayers() {
    for (const p of g_activePlayers) {
        refreshUIForPlayer(p);
    }
}

function RefreshUIForQuestScope(questInstance: QuestInstance) {
    if (questInstance.scope !== QuestScope.Player || !questInstance.player) {
        return;
    }

    refreshUIForPlayer(questInstance.player);
}