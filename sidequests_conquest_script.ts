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
            Log(STR.questManagerRegisterQuest, ctx.eventPlayer, questDef.name, QuestScope[scope]);
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
            updateSource: undefined
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
        // No reliable player context here; skipping log.

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
        this.activeQuests = this.activeQuests.filter(instance => instance.player !== player);
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
            eventTeam: ctx.eventTeam ?? questInstance.team
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
        return this.activeQuests.filter(quest => quest.player === player);
    }

    private getSquadQuests(squad: mod.Squad): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.squad === squad);
    }

    private getTeamQuests(team: mod.Team): QuestInstance[] {
        return this.activeQuests.filter(quest => quest.team === team);
    }

    private notifyQuestStart(questInstance: QuestInstance) {
        // Refresh UI for all players impacted by this quest start
        try { RefreshUIForQuestScope(questInstance); } catch {}
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
        try { RefreshUIForQuestScope(questInstance); } catch {}
    }

    private notifyQuestCompletion(questInstance: QuestInstance, ctx: QuestContext) {
        if (ctx.eventPlayer) {
            Log(STR.questCompletedNotification, ctx.eventPlayer, questInstance.quest.name);
        }

        // Update UI for all players that were seeing this quest
        try { RefreshUIForQuestScope(questInstance); } catch {}
    }
    // broadcastQuestMessage removed per simplified logging policy.

    /** Returns the most relevant quest for a given player, prioritizing Player > Squad > Team > Game */
    getRelevantQuestForPlayer(player: mod.Player): QuestInstance | undefined {
        // Player-scoped
        const playerQuest = this.activeQuests.find(q => q.scope === QuestScope.Player && q.player && mod.GetObjId(q.player) === mod.GetObjId(player));
        if (playerQuest) return playerQuest;

        // Squad-scoped
        const getSquad = (mod as any).GetSquad as undefined | ((p: mod.Player) => mod.Squad);
        const playerSquad = getSquad ? getSquad(player) : undefined;
        if (playerSquad) {
            const squadQuest = this.activeQuests.find(q => q.scope === QuestScope.Squad && q.squad && q.squad === playerSquad);
            if (squadQuest) return squadQuest;
        }

        // Team-scoped
        const playerTeam = mod.GetTeam(player);
        const teamQuest = this.activeQuests.find(q => q.scope === QuestScope.Team && q.team && q.team === playerTeam);
        if (teamQuest) return teamQuest;

        // Global
        if (this.activeGlobalQuest) return this.activeGlobalQuest;

        return undefined;
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
    onStart: (ctx: QuestContext) => {
        if (ctx.eventPlayer) {
            Log(STR.selfDamageQuestStartedLog, ctx.eventPlayer);
        }
    },
    onComplete: (ctx: QuestContext) => {
        if (ctx.eventPlayer) {
            Log(STR.selfDamageQuestCompletedLog, ctx.eventPlayer);
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

function upd_FirstKill(ctx: QuestContext): QuestUpdateResult {
    return defaultUpdateResult;
}

function upd_PistolKills(ctx: QuestContext): QuestUpdateResult {
    //todo
    return defaultUpdateResult;
}

function upd_SelfDamage(ctx: QuestContext): QuestUpdateResult {
    const progress = ctx.progress ?? new QuestProgress(1);
    const target = progress.target > 0 ? progress.target : 1;

    if (!ctx.eventPlayer) {
        return {
            current: progress.current,
            target,
            percent: progress.percent,
            state: progress.state,
            nextState: progress.state
        };
    }

    const playerId = mod.GetObjId(ctx.eventPlayer);
    const otherId = ctx.eventOtherPlayer ? mod.GetObjId(ctx.eventOtherPlayer) : -1;
    const samePlayer = otherId !== -1 && otherId === playerId;
    const isSelfDamage = samePlayer || otherId === -1;

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
    ensurePlayerQuestUI(eventPlayer);
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

    try {
        q_manager.updatePlayer(eventPlayer, QuestUpdateSource.OnPlayerReceivesDamage, ctx);
    } catch (err) {
        Log(STR.gameManagerDamageUpdateError, eventPlayer, err);
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

/////////////////////// GAMEMODE EVENTS //////////////////////////////

export async function OnGameModeEnding(): Promise<void> {}

export async function OngoingGlobal(): Promise<void> {}

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
        { quest: SelfDamageQuestDefinition, scope: QuestScope.Game, ctx: {} }
    ]);

    // Initialize quest UI for any already tracked players (if any)
    try { refreshUIForAllPlayers(); } catch {}
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

function DebugMessage(message: string, ...args: any[]) {
    mod.DisplayHighlightedWorldLogMessage(MakeMessage(message, ...args));
}

function Log(message: string, player: mod.Player, ...args: any[]) {
    const messagestr = MakeMessage(message, ...args)
    mod.DisplayHighlightedWorldLogMessage(messagestr, player);
}

/////////////////////// UI: Player Quest Panel //////////////////////////////

type PlayerQuestUI = {
    panel: mod.UIWidget;
    title: mod.UIWidget;
    desc: mod.UIWidget;
    progress: mod.UIWidget;
};

const g_playerUIs: { [playerId: number]: PlayerQuestUI } = {};
const g_activePlayers: mod.Player[] = [];
let g_uiUniqueCounter = 1;

function nextUiName(): string {
    return "sq_ui_" + (g_uiUniqueCounter++);
}

function ensurePlayerTracked(player: mod.Player) {
    const id = mod.GetObjId(player);
    if (id < 0) return;
    if (!g_activePlayers.some(p => mod.GetObjId(p) === id)) {
        g_activePlayers.push(player);
    }
}

function ensurePlayerQuestUI(player: mod.Player): PlayerQuestUI {
    const id = mod.GetObjId(player);
    if (g_playerUIs[id]) return g_playerUIs[id];

    // Layout positions (TopLeft anchored)
    const baseX = 30; // distance from left
    const baseY = 120; // distance from top
    const panelWidth = 420;
    const panelHeight = 120;

    // Panel background
    const panelName = nextUiName();
    mod.AddUIContainer(
        panelName,
        mod.CreateVector(baseX, baseY, 0),
        mod.CreateVector(panelWidth, panelHeight, 0),
        mod.UIAnchor.TopLeft,
        player
    );
    const panel = mod.FindUIWidgetWithName(panelName) as mod.UIWidget;
    mod.SetUIWidgetBgFill(panel, mod.UIBgFill.Blur);
    mod.SetUIWidgetBgColor(panel, mod.CreateVector(0.08, 0.10, 0.14));
    mod.SetUIWidgetBgAlpha(panel, 1);
    mod.SetUIWidgetDepth(panel, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetPadding(panel, 4);
    mod.SetUIWidgetVisible(panel, false);

    // Title
    const titleName = nextUiName();
    mod.AddUIText(
        titleName,
        mod.CreateVector(baseX + 12, baseY + 18, 0),
        mod.CreateVector(panelWidth - 24, 28, 0),
        mod.UIAnchor.TopLeft,
        MakeMessage(STR.empty),
        player
    );
    const title = mod.FindUIWidgetWithName(titleName) as mod.UIWidget;
    mod.SetUITextAnchor(title, mod.UIAnchor.CenterLeft);
    mod.SetUITextSize(title, 22);
    mod.SetUITextColor(title, mod.CreateVector(1, 1, 1));
    mod.SetUIWidgetDepth(title, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetVisible(title, false);

    // Description
    const descName = nextUiName();
    mod.AddUIText(
        descName,
        mod.CreateVector(baseX + 12, baseY + 52, 0),
        mod.CreateVector(panelWidth - 24, 48, 0),
        mod.UIAnchor.TopLeft,
        MakeMessage(STR.empty),
        player
    );
    const desc = mod.FindUIWidgetWithName(descName) as mod.UIWidget;
    mod.SetUITextAnchor(desc, mod.UIAnchor.TopLeft);
    mod.SetUITextSize(desc, 18);
    mod.SetUITextColor(desc, mod.CreateVector(0.9, 0.95, 1));
    mod.SetUIWidgetDepth(desc, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetVisible(desc, false);

    // Progress line
    const progName = nextUiName();
    mod.AddUIText(
        progName,
        mod.CreateVector(baseX + 12, baseY + 98, 0),
        mod.CreateVector(panelWidth - 24, 20, 0),
        mod.UIAnchor.TopLeft,
        MakeMessage(STR.empty),
        player
    );
    const progress = mod.FindUIWidgetWithName(progName) as mod.UIWidget;
    mod.SetUITextAnchor(progress, mod.UIAnchor.CenterLeft);
    mod.SetUITextSize(progress, 18);
    mod.SetUITextColor(progress, mod.CreateVector(0.8, 0.9, 1));
    mod.SetUIWidgetDepth(progress, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetVisible(progress, false);

    const ui: PlayerQuestUI = { panel, title, desc, progress };
    g_playerUIs[id] = ui;
    return ui;
}

function hidePlayerQuestUI(player: mod.Player) {
    const id = mod.GetObjId(player);
    const ui = g_playerUIs[id];
    if (!ui) return;
    mod.SetUIWidgetVisible(ui.panel, false);
    mod.SetUIWidgetVisible(ui.title, false);
    mod.SetUIWidgetVisible(ui.desc, false);
    mod.SetUIWidgetVisible(ui.progress, false);
}

function refreshUIForPlayer(player: mod.Player) {
    const id = mod.GetObjId(player);
    if (id < 0) return;
    const ui = ensurePlayerQuestUI(player);
    const quest = q_manager.getRelevantQuestForPlayer(player);

    if (!quest) {
        hidePlayerQuestUI(player);
        return;
    }

    const prog = quest.currentProgress ?? new QuestProgress(quest.quest.defaultTarget ?? 1);
    // Title and description use string keys already, so wrap with MakeMessage
    mod.SetUITextLabel(ui.title, MakeMessage(quest.quest.name));
    mod.SetUITextLabel(ui.desc, MakeMessage(quest.quest.description));
    mod.SetUITextLabel(ui.progress, MakeMessage(STR.progress, prog.current, prog.target, prog.percent));

    mod.SetUIWidgetVisible(ui.panel, true);
    mod.SetUIWidgetVisible(ui.title, true);
    mod.SetUIWidgetVisible(ui.desc, true);
    mod.SetUIWidgetVisible(ui.progress, true);
}

function refreshUIForAllPlayers() {
    for (const p of g_activePlayers) {
        refreshUIForPlayer(p);
    }
}

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

function RefreshUIForQuestScope(questInstance: QuestInstance) {
    const targets = playersMatchingQuest(questInstance);
    for (const p of targets) refreshUIForPlayer(p);
}
