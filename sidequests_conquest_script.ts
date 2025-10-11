////////////////////////////////// Models //////////////////////////////////
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
    eventWeaponUnlock?: mod.WeaponUnlock;
    progress?: QuestProgress;
    questInstance?: QuestInstance;
    updateSource?: QuestUpdateSource;
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

    constructor (target: number, current: number = 0) {
        this.target = target;
        this.current = current;
    }
}

/** Result of the quest update method */
interface QuestUpdateResult extends QuestProgress {
    nextState?: QuestState_Enum;
}
const defaultUpdateResult: QuestUpdateResult = { current: 0, target: 1, percent: 0, state: QuestState_Enum.NotStarted, nextState: QuestState_Enum.NotStarted};

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

enum QuestFailReason {
    TimeExpired,
    PlayerDied,
    PlayerLeftGame,
    OtherTeamAchievedFirst,
    PlayerReceivedDamage
}

/** Describes a quest to be completed by a squad, player or team */
class QuestDefinition {
    name: string = "" ;
    description: string = "";
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

    /** To be called to update the quest state */
    update: (ctx: QuestContext) => Promise<QuestUpdateResult>

    /** Optional; used to prepare state or emit UI when quest spawns. */
    onStart?: (ctx: QuestContext) => Promise<void>;

    /** Optional; invoked once when quest completes (can grant rewards, notify UI, spawn next quest, etc.). */
    onComplete?: (ctx: QuestContext) => Promise<void>;

    constructor() {
        this.update = async (ctx: QuestContext) => { return defaultUpdateResult; };
    }
}

/** Instance of a currently ongoing quest */
class QuestInstance {
    private static nextId = 1;

    readonly id: number;
    readonly quest: QuestDefinition;
    readonly scope: QuestScope;

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

    async init(initialQuests: { quest: QuestDefinition; scope: QuestScope; ctx: QuestContext }[] = []) {
        console.log(MakeMessage(STR.questManagerInitializing));

        this.activeQuests = [];
        this.pastQuests = [];
        this.activeGlobalQuest = undefined;

        for (const config of initialQuests) {
            await this.registerQuest(config.quest, config.scope, config.ctx);
        }
    }

    async registerQuest(questDef: QuestDefinition, scope: QuestScope, ctx: QuestContext): Promise<QuestInstance> {
        console.log(MakeMessage(STR.questManagerRegisterQuest, questDef.name, QuestScope[scope]));

        const questInstance = new QuestInstance(questDef, scope, ctx);

        if (scope === QuestScope.Game) {
            this.activeGlobalQuest = questInstance;
        } else {
            this.activeQuests.push(questInstance);
        }

        const startCtx: QuestContext = {
            ...ctx,
            questInstance,
            progress: questInstance.currentProgress,
            updateSource: undefined
        };

        if (questDef.onStart) {
            try {
                await questDef.onStart(startCtx);
            } catch (err) {
                console.error(MakeMessage(STR.questManagerOnStartError, questDef.name), err);
            }
        }

        this.notifyQuestStart(questInstance);

        return questInstance;
    }

    unregisterQuest(questInstance: QuestInstance) {
        console.log(MakeMessage(STR.questManagerUnregisterQuest, questInstance.quest.name, questInstance.id));

        if (questInstance.scope === QuestScope.Game) {
            if (this.activeGlobalQuest?.id === questInstance.id) {
                this.activeGlobalQuest = undefined;
            }
            return;
        }

        this.activeQuests = this.activeQuests.filter(instance => instance.id !== questInstance.id);
    }

    resetPlayer(player: mod.Player) {
        console.log(MakeMessage(STR.questManagerResetPlayer, player));
        this.activeQuests = this.activeQuests.filter(instance => instance.player !== player);
    }

    playerJoined(player: mod.Player) {
        const team = mod.GetTeam(player);
        console.log(MakeMessage(STR.questManagerPlayerJoined, player, team));
    }

    async updatePlayer(player: mod.Player, source: QuestUpdateSource, ctx: QuestContext): Promise<void> {
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

            await this.processQuestUpdate(questInstance, enrichedCtx);
        }
    }

    private async processQuestUpdate(questInstance: QuestInstance, ctx: QuestContext) {
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
            eventTeam: ctx.eventTeam ?? questInstance.team
        };

        console.log(MakeMessage(STR.questManagerUpdatingQuest, quest.name, questInstance.id, questCtx.eventPlayer));

        try {
            const previousCurrent = progress.current;
            const previousTarget = progress.target;
            const previousPercent = progress.percent;
            const previousState = progress.state;

            const result = await quest.update(questCtx);

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
                await this.handleQuestCompletion(questInstance, questCtx);
            }
        } catch (err) {
            LogAdmin(STR.questManagerUpdateError, quest.name, questInstance.id, err);
        }
    }

    private async handleQuestCompletion(questInstance: QuestInstance, ctx: QuestContext) {
        LogAdmin(STR.questManagerQuestCompleted, questInstance.quest.name, questInstance.id);

        this.unregisterQuest(questInstance);
        this.pastQuests.push(questInstance);

        this.notifyQuestCompletion(questInstance, ctx);

        if (questInstance.quest.onComplete) {
            try {
                await questInstance.quest.onComplete(ctx);
            } catch (err) {
                LogAdmin(STR.questManagerOnCompleteError, questInstance.quest.name, err);
            }
        }

    }

    private getPlayerQuests(player: mod.Player): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.player === player);
    }

    private getSquadQuests(squad: mod.Squad): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.squad === squad);
    }

    private getTeamQuests(team: mod.Team): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.team === team);
    }

    private notifyQuestStart(questInstance: QuestInstance) {
        this.broadcastQuestMessage(questInstance, STR.questStartedNotification, [questInstance.quest.name]);
    }

    private notifyQuestProgress(questInstance: QuestInstance, ctx: QuestContext, previousPercent: number, nextPercent: number) {
        if (nextPercent === previousPercent) {
            return;
        }

        const clampedPercent = Math.min(100, Math.max(0, Math.round(nextPercent)));
        this.broadcastQuestMessage(questInstance, STR.questProgressNotification, [questInstance.quest.name, clampedPercent], ctx.eventPlayer);
    }

    private notifyQuestCompletion(questInstance: QuestInstance, ctx: QuestContext) {
        this.broadcastQuestMessage(questInstance, STR.questCompletedNotification, [questInstance.quest.name], ctx.eventPlayer);
    }

    private broadcastQuestMessage(questInstance: QuestInstance, messageKey: string, args: any[] = [], preferredPlayer?: mod.Player) {
        switch (questInstance.scope) {
            case QuestScope.Player:
                if (questInstance.player) {
                    LogAdmin(STR.questManagerNotifyPlayer, questInstance.player, questInstance.quest.name);
                    return;
                }
                break;
            case QuestScope.Team:
                if (questInstance.team) {
                    LogAdmin(STR.questManagerNotifyTeam, questInstance.team, questInstance.quest.name);
                    return;
                }
                break;
            case QuestScope.Squad:
                if (questInstance.squad) {
                    const players = ConvertArray(mod.AllPlayers()) as mod.Player[];
                    for (const player of players) {
                        if (mod.GetSquad(player) === questInstance.squad) {
                            LogAdmin(STR.questManagerNotifyPlayer, player, questInstance.quest.name);
                        }
                    }
                    return;
                }
                break;
            case QuestScope.Game:
                LogAdmin(STR.questManagerNotifyAll, questInstance.quest.name);
                return;
        }

        if (preferredPlayer) {
            LogAdmin(STR.questManagerNotifyPlayer, preferredPlayer, questInstance.quest.name);
        } else {
            LogAdmin(STR.questManagerNotifyNoRecipient, questInstance.quest.name);
        }
    }
}


////////////////////////////////// Data //////////////////////////////////

var q_manager = new QuestManager();

var requiredPlayersToStart: number = 4;
var gameStartCountdown: number = 60;

const SELF_DAMAGE_QUEST_NAME = STR.selfDamageQuestName;

const SelfDamageQuestDefinition: QuestDefinition = {
    name: SELF_DAMAGE_QUEST_NAME,
    description: STR.selfDamageQuestDescription,
    availableScope: [QuestScope.Game],
    defaultTarget: 1,
    updateSources: [QuestUpdateSource.OnPlayerReceivesDamage],
    update: upd_SelfDamage,
    onStart: async (ctx: QuestContext) => {
        LogAdmin(STR.selfDamageQuestStartedLog);
    },
    onComplete: async (ctx: QuestContext) => {
        LogAdmin(STR.selfDamageQuestCompletedLog, ctx.eventPlayer);

        try {
            await q_manager.registerQuest(SelfDamageQuestDefinition, QuestScope.Game, {});
        } catch (err) {
            LogAdmin(STR.selfDamageQuestRestartError, err);
        }
    }
};

/** Implementation of all available quests */
var QuestRegistry: QuestDefinition[] = [
    {
        name: STR.firstBloodQuestName,
        description: STR.firstBloodQuestDescription,
        availableScope: [QuestScope.Game],
        updateSources: [QuestUpdateSource.OnPlayerEarnedKill],
        update: upd_FirstKill
    },
    {
        name: STR.pistolQuestName,
        description: STR.pistolQuestDescription,
        availableScope: AllQuestScopes,
        updateSources: [QuestUpdateSource.OnPlayerEarnedKill],
        update: upd_PistolKills
    },
    SelfDamageQuestDefinition
];

function upd_FirstKill(ctx: QuestContext): Promise<QuestUpdateResult> {
    return Promise.resolve(defaultUpdateResult);
}

function upd_PistolKills(ctx: QuestContext): Promise<QuestUpdateResult> {
    //todo
    return Promise.resolve(defaultUpdateResult);
}

async function upd_SelfDamage(ctx: QuestContext): Promise<QuestUpdateResult> {
    const progress = ctx.progress ?? new QuestProgress(1);
    const target = progress.target > 0 ? progress.target : 1;
    const isSelfDamage = !!ctx.eventPlayer && ctx.eventPlayer === ctx.eventOtherPlayer;

    if (!ctx.eventPlayer) {
        LogAdmin(STR.selfDamageQuestUpdateNoPlayer);

        return {
            current: progress.current,
            target,
            percent: progress.percent,
            state: progress.state,
            nextState: progress.state
        };
    }

    if (!isSelfDamage) {
        
        return {
            current: progress.current,
            target,
            percent: progress.percent,
            state: progress.state,
            nextState: progress.state
        };
    }

    const nextCurrent = Math.min(progress.current + 1, target);
    const completed = nextCurrent >= target;
    const nextState = completed ? QuestState_Enum.Completed : QuestState_Enum.InProgress;
    const percent = Math.round(Math.min(1, nextCurrent / target) * 100);

    LogAdmin(STR.selfDamageQuestProgressLog, ctx.eventPlayer, nextCurrent, target);
    Log(STR.selfDamageQuestProgressLog, ctx.eventPlayer, nextCurrent, target);

    return {
        current: nextCurrent,
        target,
        percent,
        state: nextState,
        nextState
    };
}

////////////////////////////////// PLAYER EVENTS ///////////////////////////////////////

// Triggered when player joins the game
export async function OnPlayerJoinGame(eventPlayer: mod.Player): Promise<void> {
}

// Triggered when player leaves the game
export async function OnPlayerLeaveGame(eventNumber: number): Promise<void> {
}

// Triggered when player selects their class and deploys into game
export async function OnPlayerDeployed(eventPlayer: mod.Player): Promise<void> {
    LogAdmin(STR.gameManagerPlayerDeployedLog, eventPlayer);
}

// Triggered on player death/kill, returns dying player, the killer, etc. Useful for updating scores, updating progression, handling any death/kill related logic.
export async function OnPlayerDied(eventPlayer: mod.Player, eventOtherPlayer: mod.Player, eventDeathType: mod.DeathType, eventWeaponUnlock: mod.WeaponUnlock): Promise<void> {
}

export async function OnPlayerEarnedKill(
    eventPlayer: mod.Player,
    eventOtherPlayer: mod.Player,
    eventDeathType: mod.DeathType,
    eventWeaponUnlock: mod.WeaponUnlock
): Promise<void> {}

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

    q_manager
        .updatePlayer(eventPlayer, QuestUpdateSource.OnPlayerReceivesDamage, ctx)
        .catch(err => LogAdmin(STR.gameManagerDamageUpdateError, err));
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

/////////////////////// GAMEMODE EVENTS //////////////////////////////

export async function OnGameModeEnding(): Promise<void> {}

export async function OngoingGlobal(): Promise<void> {}

// Triggered on main gamemode start/end. Useful for game start setup and cleanup.
export async function OnGameModeStarted(): Promise<void> {
    mod.EnableHQ(mod.GetHQ(0), true);
    mod.EnableHQ(mod.GetHQ(1), true);
    
    // mod.AllCapturePoints
    mod.SetGameModeTargetScore(1000);
    mod.SetGameModeTimeLimit(20); // minutes

    const cps = ConvertArray(mod.AllCapturePoints()) as mod.CapturePoint[];
    for (const cp of cps) {
        mod.EnableCapturePointDeploying(cp, true);
        mod.EnableGameModeObjective(cp, true);
    }

    // Adds X delay in seconds. Useful for making sure that everything has been initialized before running logic or delaying triggers.
    await mod.Wait(1);

    await q_manager.init([
        { quest: SelfDamageQuestDefinition, scope: QuestScope.Game, ctx: {} }
    ]);
}


/////////////////////// LIB //////////////////////////////

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

function Log(message: string, player: mod.Player, ...args: any[]) {
    mod.DisplayHighlightedWorldLogMessage(MakeMessage(message, ...args), player);
}

function LogAdmin(message: string, ...args: any[]) {
    mod.SendErrorReport(MakeMessage(message, ...args));
}