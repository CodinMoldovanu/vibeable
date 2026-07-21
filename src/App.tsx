import {
  Activity, Archive, Bot, Boxes, Check, ChevronDown, CircleDollarSign, Cloud, Code2, FileCode2,
  Database, Gauge, GitBranch, KeyRound, LayoutDashboard, LoaderCircle, Lock, LogOut,
  MessageSquare, Monitor, Pencil, Play, Plug, Plus, Menu, RefreshCw, Rocket, RotateCcw, ScrollText,
  Server, ShieldCheck, Smartphone, Tablet, Terminal, Trash2, UploadCloud, Users, X, Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { AgentPhase, EffectiveAiPolicy, Role } from "./domain/types";

type RightPanelTab = "files" | "logs" | "resources" | "git" | "metrics" | "deploy";
type ViewportMode = "desktop" | "tablet" | "mobile";

interface Session {
  user: { userId: string; organizationId: string; name: string; email: string; role: Role; organizationName: string };
  teams: Array<{ id: string; name: string; role: Role }>;
}
interface AuthOptions { localLoginEnabled: boolean; oidc: { enabled: boolean; displayName: string } }
interface Project {
  id: string; name: string; slug: string; status: string; environment: string;
  teamId: string; teamName: string; updatedAt: string; previewUrl: string; activeBranch: string;
  archivedAt?: string; deletedAt?: string; offloadedAt?: string;
}
interface RunEvent { sequence: number; type: string; message: string; metadata: Record<string, unknown>; createdAt: string }
interface ChangedFile { path: string; additions: number; deletions: number; summary: string }
interface Run {
  id: string; userId: string; phase: AgentPhase; prompt: string; status: string; providerId?: string; model?: string;
  commitSha?: string; totalTokens: number; estimatedCostUsd: number; progress: number; stageMessage: string;
  repairAttempts: number; createdAt: string; finishedAt?: string; events: RunEvent[]; files: ChangedFile[];
  targetBranch: string; workerId?: string;
}
interface UsageRow { day: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; requests: number }
interface MetricScope { scope: "global" | "team" | "user" | "project"; id: string; label: string }
interface DeploymentEvent { id: string; type: string; level: string; message: string; createdAt: string }
interface Deployment { id: string; environment: string; status: string; requestedBy: string; approvedBy?: string; commitSha?: string; branch: string; profileName?: string; adapter?: string; createdAt: string; events: DeploymentEvent[] }
interface ProviderOption { id: string; name: string; defaultModel: string; allowedModels: string[] }
interface ProjectResource { id: string; kind: "secret" | "api" | "smtp" | "database" | "git" | "service"; name: string; environment: string; config: Record<string, unknown>; configured: boolean; updatedAt: string }
interface RuntimeLog { id: string; runId?: string; source: string; level: "debug" | "info" | "warn" | "error"; message: string; createdAt: string }
interface ProjectWorker { id: string; name: string; baseBranch: string; workingBranch: string; autoPush: boolean; status: string; lastRunId?: string }
interface DeploymentProfile { id: string; name: string; adapter: string; environment: "staging" | "production"; config: Record<string, unknown>; resourceNames: string[]; enabled: boolean }
interface StackProfileOption { id: string; name: string; description: string; scopeType: string; isDefault: boolean }
interface DeliveryState {
  git: null | { repositoryUrl: string; defaultBranch: string; branchPrefix: string; syncMode: "mirror" | "source"; credentialType: "bearer" | "basic"; enabled: boolean; hasCredential: boolean; lastSyncAt?: string; lastSyncStatus?: string };
  branches: string[]; workers: ProjectWorker[]; deploymentProfiles: DeploymentProfile[]; stackProfiles: StackProfileOption[];
  activeBranch: string; stackProfileId?: string; archivedAt?: string; deletedAt?: string; offloadedAt?: string;
}

const phases: AgentPhase[] = [
  "project:create", "agent:before_plan", "agent:before_edit", "agent:after_edit", "agent:after_error",
  "agent:before_test", "agent:after_test_failure", "deploy:prepare", "deploy:preflight", "deploy:post_success",
  "deploy:post_failure", "summarize_logs", "classify_error", "generate_commit_message", "database_migration",
  "production_deploy_prepare"
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [authOptions, setAuthOptions] = useState<AuthOptions>({ localLoginEnabled: true, oidc: { enabled: false, displayName: "Company SSO" } });
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState("");

  const loadSession = useCallback(async () => {
    setLoading(true);
    setStartupError("");
    try {
      const value = await api<Session>("/api/session");
      setSession(value);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const setup = await api<{ needsBootstrap: boolean } & AuthOptions>("/api/auth/setup-status");
        setNeedsBootstrap(setup.needsBootstrap);
        setAuthOptions({ localLoginEnabled: setup.localLoginEnabled, oidc: setup.oidc });
        setSession(null);
      } else {
        setStartupError(error instanceof Error ? error.message : "The Vibeable API is unavailable");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);
  if (loading) return <div className="centerState"><Zap size={24} /><span>Loading Vibeable</span></div>;
  if (startupError) return <ServiceUnavailable message={startupError} retry={loadSession} />;
  if (!session) return <AuthScreen bootstrap={needsBootstrap} options={authOptions} onAuthenticated={loadSession} />;
  return <Builder session={session} onLogout={async () => { await api("/api/auth/logout", { method: "POST" }); await loadSession(); }} />;
}

function AuthScreen({ bootstrap, options, onAuthenticated }: { bootstrap: boolean; options: AuthOptions; onAuthenticated: () => Promise<void> }) {
  const initialError = new URLSearchParams(window.location.search).get("auth_error");
  const [error, setError] = useState(initialError === "provisioning_denied" ? "Your identity is valid, but access has not been provisioned." : initialError ? "Single sign-on failed. Try again or contact an administrator." : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initialError) window.history.replaceState({}, "", window.location.pathname); }, [initialError]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(bootstrap ? "/api/auth/bootstrap" : "/api/auth/login", { method: "POST", body: JSON.stringify(data) });
      await onAuthenticated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Authentication failed"); }
    finally { setBusy(false); }
  }
  return <main className="authShell">
    <section className="authPanel">
      <div className="authBrand"><span className="brandMark"><Zap size={20} /></span><div><strong>Vibeable</strong><small>Self-hosted app builder</small></div></div>
      <h1>{bootstrap ? "Create your workspace" : "Sign in"}</h1>
      {!bootstrap && options.oidc.enabled && <a className="oidcButton" href="/api/auth/oidc/start"><KeyRound size={17} />Continue with {options.oidc.displayName}</a>}
      {!bootstrap && options.oidc.enabled && options.localLoginEnabled && <div className="authDivider"><span>or use a local account</span></div>}
      {(bootstrap || options.localLoginEnabled) && <form onSubmit={submit}>
        {bootstrap && <><label>Organization<input name="organizationName" required minLength={2} /></label><label>Your name<input name="name" autoComplete="name" required /></label></>}
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" minLength={bootstrap ? 12 : 1} autoComplete={bootstrap ? "new-password" : "current-password"} required /></label>
        {bootstrap && <div className="providerSetup"><label>AI endpoint<input name="providerUrl" type="url" defaultValue="https://openrouter.ai/api/v1" required /></label><label>Model<input name="providerModel" defaultValue="openai/gpt-5-mini" required /></label><label>API key<input name="apiKey" type="password" autoComplete="off" /></label></div>}
        {error && <p className="formError" role="alert">{error}</p>}
        <button className="primaryButton" disabled={busy}>{busy ? "Working..." : bootstrap ? "Create workspace" : "Sign in"}</button>
      </form>}
      {!bootstrap && !options.localLoginEnabled && !options.oidc.enabled && <p className="formError" role="alert">No authentication method is currently available.</p>}
    </section>
  </main>;
}

function Builder({ session, onLogout }: { session: Session; onLogout: () => Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [policy, setPolicy] = useState<EffectiveAiPolicy | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [metricScopes, setMetricScopes] = useState<MetricScope[]>([]);
  const [metricScopeKey, setMetricScopeKey] = useState("");
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [resources, setResources] = useState<ProjectResource[]>([]);
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);
  const [targetBranch, setTargetBranch] = useState("main");
  const [workerId, setWorkerId] = useState("");
  const [projectLifecycle, setProjectLifecycle] = useState<"active" | "archived" | "trash">("active");
  const [projectTeams, setProjectTeams] = useState<Array<{ id: string; name: string }>>(session.teams);
  const [tab, setTab] = useState<RightPanelTab>("files");
  const [viewport, setViewport] = useState<ViewportMode>("desktop");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [view, setView] = useState<"builder" | "teams" | "policy" | "delivery">("builder");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    const result = await api<{ projects: Project[] }>(`/api/projects?lifecycle=${projectLifecycle}`); setProjects(result.projects);
    setProjectId((current) => result.projects.some((project) => project.id === current) ? current : result.projects[0]?.id || "");
  }, [projectLifecycle]);
  const loadProjectTeams = useCallback(async () => {
    if (!["owner", "admin"].includes(session.user.role)) return setProjectTeams(session.teams);
    const result = await api<{ teams: Array<{ id: string; name: string }> }>("/api/admin/teams");
    setProjectTeams(result.teams);
  }, [session]);
  const refreshProject = useCallback(async () => {
    if (!projectId) return;
    const [runResult, policyResult, deploymentResult, providerResult, resourceResult, logResult, deliveryResult] = await Promise.all([
      api<{ runs: Run[] }>(`/api/projects/${projectId}/runs`),
      api<{ policy: EffectiveAiPolicy }>(`/api/projects/${projectId}/policy`),
      api<{ deployments: Deployment[] }>(`/api/projects/${projectId}/deployments`),
      api<{ providers: ProviderOption[]; selected: { providerId: string; model: string } }>(`/api/projects/${projectId}/provider-options`),
      api<{ resources: ProjectResource[] }>(`/api/projects/${projectId}/resources`),
      api<{ logs: RuntimeLog[] }>(`/api/projects/${projectId}/logs`),
      api<DeliveryState>(`/api/projects/${projectId}/delivery`)
    ]);
    setRuns(runResult.runs); setPolicy(policyResult.policy); setDeployments(deploymentResult.deployments);
    setProviderOptions(providerResult.providers); setResources(resourceResult.resources); setLogs(logResult.logs);
    setDelivery(deliveryResult);
    setTargetBranch((current) => deliveryResult.branches.includes(current) ? current : deliveryResult.activeBranch || "main");
    setWorkerId((current) => deliveryResult.workers.some((worker) => worker.id === current && worker.status === "active") ? current : "");
    setProviderId((current) => providerResult.providers.some((provider) => provider.id === current) ? current : providerResult.selected.providerId);
    setModel((current) => providerResult.providers.some((provider) => provider.id === providerId && provider.allowedModels.includes(current)) ? current : providerResult.selected.model);
  }, [projectId, providerId]);
  const loadMetricScopes = useCallback(async () => {
    const result = await api<{ scopes: MetricScope[] }>("/api/metrics/scopes");
    setMetricScopes(result.scopes);
    setMetricScopeKey((current) => current || (result.scopes[0] ? `${result.scopes[0].scope}:${result.scopes[0].id}` : ""));
  }, []);
  const loadUsage = useCallback(async () => {
    if (!metricScopeKey) return;
    const [scope, id] = metricScopeKey.split(":");
    try { const result = await api<{ usage: UsageRow[] }>(`/api/metrics/usage?scope=${scope}&id=${id}`); setUsage(result.usage); }
    catch { setUsage([]); }
  }, [metricScopeKey]);

  useEffect(() => { void loadProjects().catch(showError(setError)); void loadMetricScopes().catch(showError(setError)); void loadProjectTeams().catch(showError(setError)); }, [loadMetricScopes, loadProjectTeams, loadProjects]);
  useEffect(() => { if (view === "builder") void loadProjectTeams().catch(showError(setError)); }, [loadProjectTeams, view]);
  useEffect(() => { void loadUsage(); }, [loadUsage]);
  useEffect(() => { void refreshProject().catch(showError(setError)); }, [refreshProject]);
  const activeRun = runs[0]; const activeProject = projects.find((project) => project.id === projectId);
  const selectedProvider = providerOptions.find((provider) => provider.id === providerId);
  useEffect(() => {
    if (!selectedProvider) return;
    setModel((current) => selectedProvider.allowedModels.includes(current) ? current : selectedProvider.defaultModel);
  }, [selectedProvider]);
  useEffect(() => {
    if (!activeRun || ["ready", "failed"].includes(activeRun.status)) return;
    const source = new EventSource(`/api/runs/${activeRun.id}/events`);
    source.onmessage = () => { void refreshProject(); void loadUsage(); };
    const poll = window.setInterval(() => { void refreshProject(); void loadUsage(); }, 3000);
    return () => { source.close(); window.clearInterval(poll); };
  }, [activeRun?.id, activeRun?.status, loadUsage, refreshProject]);

  async function startRun() {
    if (!projectId || !prompt.trim()) return;
    setError("");
    try { await api(`/api/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify({ prompt, providerId, model, targetBranch, workerId: workerId || undefined }) }); setPrompt(""); await refreshProject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Run failed to start"); }
  }
  async function approveRun() {
    if (!activeRun) return;
    setError("");
    try { await api(`/api/runs/${activeRun.id}/approve`, { method: "POST" }); await refreshProject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Run approval failed"); }
  }
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify(data) }); await loadProjects(); await loadMetricScopes(); setProjectId(result.id); setCreateOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Project creation failed"); }
  }
  async function createDeployment(profileId: string, branch: string) {
    if (!projectId) return;
    setError("");
    try { await api(`/api/projects/${projectId}/deployments`, { method: "POST", body: JSON.stringify({ profileId, branch }) }); await refreshProject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Deployment request failed"); }
  }
  async function approveDeployment(deploymentId: string) {
    setError("");
    try { await api(`/api/deployments/${deploymentId}/approve`, { method: "POST" }); await refreshProject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Deployment approval failed"); }
  }
  async function deploymentAction(deploymentId: string, action: "execute" | "rollback") {
    await api(`/api/deployments/${deploymentId}/${action}`, { method: "POST" }); await refreshProject();
  }
  async function projectAction(action: "archive" | "restore" | "trash" | "purge", body?: unknown) {
    if (!projectId) return;
    const path = action === "trash" ? `/api/projects/${projectId}` : action === "purge" ? `/api/projects/${projectId}/purge` : `/api/projects/${projectId}/${action}`;
    await api(path, { method: action === "trash" || action === "purge" ? "DELETE" : "POST", body: body ? JSON.stringify(body) : undefined });
    await loadProjects();
  }
  async function saveResource(input: Record<string, unknown>) {
    await api(`/api/projects/${projectId}/resources`, { method: "POST", body: JSON.stringify(input) });
    await refreshProject();
  }
  async function provisionDatabase() {
    await api(`/api/projects/${projectId}/resources/database`, { method: "POST" });
    await refreshProject();
  }
  async function removeResource(resourceId: string) {
    await api(`/api/projects/${projectId}/resources/${resourceId}`, { method: "DELETE" });
    await refreshProject();
  }

  const builderActive = view === "builder" && tab !== "metrics";
  const usageActive = view === "builder" && tab === "metrics";
  return <main className="appShell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brandLockup"><div className="brandMark"><Zap size={18} /></div><div><strong>Vibeable</strong><span>{session.user.organizationName}</span></div><button type="button" className="miniIcon sidebarClose" aria-label="Close navigation" title="Close navigation" onClick={() => setSidebarOpen(false)}><X size={17} /></button></div>
      <nav className="navStack" aria-label="Main navigation">
        <span className="navLabel">Workspace</span>
        <button type="button" aria-current={builderActive ? "page" : undefined} className={`navItem ${builderActive ? "active" : ""}`} onClick={() => { setView("builder"); setTab("files"); setSidebarOpen(false); }}><LayoutDashboard size={18} /><span>Builder</span></button>
        <button type="button" aria-current={usageActive ? "page" : undefined} className={`navItem ${usageActive ? "active" : ""}`} onClick={() => { setView("builder"); setTab("metrics"); setSidebarOpen(false); }}><Gauge size={18} /><span>Usage</span></button>
        {["owner", "admin"].includes(session.user.role) && <><span className="navLabel adminLabel">Administration</span><button type="button" aria-current={view === "teams" ? "page" : undefined} className={`navItem ${view === "teams" ? "active" : ""}`} onClick={() => { setView("teams"); setSidebarOpen(false); }}><Users size={18} /><span>Teams & users</span></button><button type="button" aria-current={view === "policy" ? "page" : undefined} className={`navItem ${view === "policy" ? "active" : ""}`} onClick={() => { setView("policy"); setSidebarOpen(false); }}><ShieldCheck size={18} /><span>AI governance</span></button><button type="button" aria-current={view === "delivery" ? "page" : undefined} className={`navItem ${view === "delivery" ? "active" : ""}`} onClick={() => { setView("delivery"); setSidebarOpen(false); }}><Server size={18} /><span>Stacks & delivery</span></button></>}
      </nav>
      <section className="sideSection"><div className="sectionTitleRow"><span className="sectionTitle">Projects</span><button className="miniIcon" title="Create project" onClick={() => setCreateOpen(!createOpen)}><Plus size={15} /></button></div>
        <div className="projectFilters"><button className={projectLifecycle === "active" ? "active" : ""} onClick={() => setProjectLifecycle("active")}>Active</button><button className={projectLifecycle === "archived" ? "active" : ""} onClick={() => setProjectLifecycle("archived")}>Archive</button><button className={projectLifecycle === "trash" ? "active" : ""} onClick={() => setProjectLifecycle("trash")}>Trash</button></div>
        {createOpen && <form className="quickCreate" onSubmit={createProject}><input name="name" placeholder="Project name" required /><select name="teamId" required>{projectTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select><button className="primaryButton">Create</button></form>}
        <div className="projectList">{projects.map((project) => <button className={`projectButton ${project.id === projectId ? "selected" : ""}`} key={project.id} onClick={() => { setProjectId(project.id); setSidebarOpen(false); }}><span>{project.name}</span><small>{project.environment}</small></button>)}</div>
      </section>
      <div className="accountBlock"><span className="accountAvatar" aria-hidden="true">{getInitials(session.user.name)}</span><div><strong>{session.user.name}</strong><span>{session.user.email}</span></div><span className="roleBadge">{session.user.role}</span><button type="button" className="miniIcon" aria-label="Sign out" title="Sign out" onClick={() => void onLogout()}><LogOut size={16} /></button></div>
    </aside>
    {sidebarOpen && <button type="button" className="sidebarBackdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <section className="workspace">
      <header className="topbar"><button type="button" className="iconButton mobileMenuButton" aria-label="Open navigation" title="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button><div className="topbarTitle"><div className="eyebrow"><span>{view === "builder" ? activeProject?.teamName ?? "Workspace" : session.user.organizationName}</span>{view === "builder" && activeProject && <><i /> <span>{activeProject.environment}</span><i /> <span>{delivery?.activeBranch ?? activeProject.activeBranch}</span></>}</div><h1>{view === "teams" ? "Teams & users" : view === "policy" ? "AI governance" : view === "delivery" ? "Stacks & delivery" : activeProject?.name ?? "Create a project"}</h1></div><div className="topbarActions">{view === "builder" && activeProject && <StatusPill label={activeProject.status} tone="blue" />}{view === "builder" && policy && <StatusPill label={policy.provider.name} tone="green" />}<button type="button" className="iconButton" aria-label="Refresh current view" title="Refresh" onClick={() => view === "builder" ? void refreshProject() : setView(view)}><RefreshCw size={18} /></button></div></header>
      {error && <div className="errorBanner" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {view === "delivery" ? <DeliveryGovernancePanel session={session} projects={projects} onError={setError} /> : view !== "builder" ? <GovernancePanel mode={view} session={session} projects={projects} onError={setError} /> : !activeProject ? <EmptyProject onCreate={() => setCreateOpen(true)} /> : activeProject.archivedAt || activeProject.deletedAt ? <LifecycleProject project={activeProject} onRestore={() => projectAction("restore")} onPurge={() => projectAction("purge")} /> : <section className="mainGrid">
        <ChatPanel prompt={prompt} run={activeRun} providers={providerOptions} providerId={providerId} model={model} branches={delivery?.branches ?? [activeProject.activeBranch]} workers={delivery?.workers ?? []} targetBranch={targetBranch} workerId={workerId} canApprove={Boolean(activeRun?.status === "waiting_approval" && activeRun.userId !== session.user.userId && ["owner", "admin", "reviewer"].includes(session.user.role))} onProviderChange={setProviderId} onModelChange={setModel} onTargetBranchChange={setTargetBranch} onWorkerChange={setWorkerId} onPromptChange={setPrompt} onStartRun={startRun} onApproveRun={approveRun} />
        <PreviewPanel project={activeProject} run={activeRun} viewport={viewport} onViewportChange={setViewport} onLog={() => void refreshProject()} />
        <RightPanel activeTab={tab} onChangeTab={setTab} run={activeRun} policy={policy} usage={usage} logs={logs} resources={resources} metricScopes={metricScopes} metricScopeKey={metricScopeKey} onMetricScopeChange={setMetricScopeKey} deployments={deployments} delivery={delivery} project={activeProject} currentUserId={session.user.userId} role={session.user.role} onDeploy={createDeployment} onApproveDeployment={approveDeployment} onDeploymentAction={deploymentAction} onRefresh={refreshProject} onProjectAction={projectAction} onSaveResource={saveResource} onProvisionDatabase={provisionDatabase} onRemoveResource={removeResource} onError={setError} />
      </section>}
    </section>
  </main>;
}

function ChatPanel({ prompt, run, providers, providerId, model, branches, workers, targetBranch, workerId, canApprove, onProviderChange, onModelChange, onTargetBranchChange, onWorkerChange, onPromptChange, onStartRun, onApproveRun }: { prompt: string; run?: Run; providers: ProviderOption[]; providerId: string; model: string; branches: string[]; workers: ProjectWorker[]; targetBranch: string; workerId: string; canApprove: boolean; onProviderChange: (value: string) => void; onModelChange: (value: string) => void; onTargetBranchChange: (value: string) => void; onWorkerChange: (value: string) => void; onPromptChange: (value: string) => void; onStartRun: () => void; onApproveRun: () => void }) {
  const provider = providers.find((item) => item.id === providerId);
  const recommendedModel = provider?.allowedModels.includes(provider.defaultModel) ? provider.defaultModel : provider?.allowedModels[0];
  const approvedModels = provider?.allowedModels.filter((item) => item !== recommendedModel) ?? [];
  const working = Boolean(run && !["ready", "failed"].includes(run.status));
  const progress = run && ["ready", "failed"].includes(run.status) ? 100 : run?.progress ?? 0;
  const elapsed = useElapsed(run, working);
  const stages = ["planning", "editing", "testing", "ready"];
  const currentStage = run?.status === "waiting_approval" || run?.status === "queued" ? "planning" : run?.status;
  return <section className={`panel chatPanel ${working ? "isBuilding" : ""}`}><div className="panelHeader"><div className="panelTitle"><span className="panelIcon"><MessageSquare size={17} /></span><span>Build agent</span></div>{run ? <StatusPill label={run.status.replaceAll("_", " ")} tone={run.status === "failed" ? "amber" : run.status === "ready" ? "green" : "blue"} /> : <span className="panelMeta">Ready</span>}</div>
    {run && <div className={`runProgress ${working ? "working" : ""}`} aria-live="polite"><div className="runProgressHeading"><span>{working && <LoaderCircle className="spin" size={15} />}{run.stageMessage || run.status}</span><strong>{working ? formatElapsed(elapsed) : `${progress}%`}</strong></div><progress aria-label="Build progress" value={progress} max="100" /><div className="stageRail">{stages.map((stage) => <span className={stageState(stage, currentStage)} key={stage}><i />{stage}</span>)}</div></div>}
    <div className="messageStream" aria-live="polite">{run ? <><div className="message userMessage"><span className="avatar">YOU</span><p>{run.prompt}</p></div><div className="message agentMessage"><span className="agentAvatar"><Bot size={16} /></span><div><strong>Build activity</strong><ol className="eventTimeline">{run.events.map((event) => <li className={event.type} key={event.sequence}><span>{event.message}</span><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ol></div></div></> : <div className="emptyRun"><span className="emptyRunIcon"><Bot size={22} /></span><strong>What should we build?</strong><p>Describe the product, workflow, or change.</p></div>}</div>
    <div className="composer"><div className="composerHeading"><span>Build context</span><small>{workers.find((worker) => worker.id === workerId)?.workingBranch ?? targetBranch}</small></div><div className="providerControls"><label className="contextField"><span>Provider</span><span className="selectShell"><select aria-label="AI provider" value={providerId} onChange={(event) => onProviderChange(event.target.value)}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><ChevronDown size={16} /></span></label><label className="contextField"><span className="contextLabel">Model{model === recommendedModel && <small>Recommended</small>}</span><span className="selectShell"><select aria-label="AI model" value={model} onChange={(event) => onModelChange(event.target.value)}>{recommendedModel && <optgroup label="Recommended"><option value={recommendedModel}>{recommendedModel}</option></optgroup>}{approvedModels.length > 0 && <optgroup label="Approved models">{approvedModels.map((item) => <option value={item} key={item}>{item}</option>)}</optgroup>}</select><ChevronDown size={16} /></span></label></div><div className="providerControls"><label className="contextField"><span>Branch</span><span className="selectShell"><select aria-label="Git branch" value={targetBranch} disabled={Boolean(workerId)} onChange={(event) => onTargetBranchChange(event.target.value)}>{branches.map((branch) => <option value={branch} key={branch}>{branch}</option>)}</select><GitBranch size={15} /></span></label><label className="contextField"><span>Worker</span><span className="selectShell"><select aria-label="Git worker" value={workerId} onChange={(event) => onWorkerChange(event.target.value)}><option value="">Direct branch</option>{workers.filter((worker) => worker.status === "active").map((worker) => <option value={worker.id} key={worker.id}>{worker.name}: {worker.workingBranch}</option>)}</select><ChevronDown size={16} /></span></label></div><label className="promptField"><span>Request</span><textarea aria-label="Build request" value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={4} placeholder="Build an account dashboard with..." /></label><div className="composerActions">{canApprove && <button type="button" className="secondaryButton" onClick={onApproveRun}><ShieldCheck size={17} />Approve run</button>}<button type="button" className="primaryButton" onClick={onStartRun} disabled={!prompt.trim() || working || !providerId || !model}>{working ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}{working ? "Building" : "Start build"}</button></div></div>
  </section>;
}

function PreviewPanel({ project, run, viewport, onViewportChange, onLog }: { project: Project; run?: Run; viewport: ViewportMode; onViewportChange: (value: ViewportMode) => void; onLog: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewRevision = run?.events.filter((event) => ["file", "complete"].includes(event.type)).at(-1)?.sequence ?? 0;
  const progress = run && ["ready", "failed"].includes(run.status) ? 100 : run?.progress ?? 0;
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.source !== "vibeable-preview" || event.data?.projectId !== project.id) return;
      void api(`/api/projects/${project.id}/logs`, { method: "POST", body: JSON.stringify({ level: event.data.level, message: event.data.message }) }).then(onLog).catch(() => undefined);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onLog, project.id, run?.id]);
  return <section className="panel previewPanel"><div className="panelHeader"><div className="panelTitle"><span className="panelIcon"><Monitor size={17} /></span><span>Live preview</span><span className="liveIndicator"><i />Live</span></div><div className="segmented" role="group" aria-label="Preview viewport"><ViewportButton value="desktop" active={viewport} set={onViewportChange} icon={<Monitor size={16} />} /><ViewportButton value="tablet" active={viewport} set={onViewportChange} icon={<Tablet size={16} />} /><ViewportButton value="mobile" active={viewport} set={onViewportChange} icon={<Smartphone size={16} />} /></div></div>
    <div className={`previewStage ${viewport}`}><div className="previewBrowser"><div className="previewChrome"><div className="previewDots" aria-hidden="true"><span /><span /><span /></div><div className="previewUrl"><Lock size={13} /><span>{project.previewUrl}</span></div><button type="button" aria-label="Reload preview" title="Reload preview" onClick={() => { if (iframeRef.current) iframeRef.current.src = iframeRef.current.src; }}><RefreshCw size={14} /></button></div><iframe ref={iframeRef} key={`${project.id}-${run?.id}-${previewRevision}`} src={`${project.previewUrl}?revision=${previewRevision}`} title={`${project.name} preview`} sandbox="allow-scripts allow-forms allow-modals" /></div></div>
    <footer className="previewFooter"><div><Activity className={run && !["ready", "failed"].includes(run.status) ? "pulse" : ""} size={16} />{run?.stageMessage || "Preview ready"}</div><div><Terminal size={16} />{progress}%</div></footer>
  </section>;
}

function RightPanel({ activeTab, onChangeTab, run, policy, usage, logs, resources, metricScopes, metricScopeKey, onMetricScopeChange, deployments, delivery, project, currentUserId, role, onDeploy, onApproveDeployment, onDeploymentAction, onRefresh, onProjectAction, onSaveResource, onProvisionDatabase, onRemoveResource, onError }: { activeTab: RightPanelTab; onChangeTab: (tab: RightPanelTab) => void; run?: Run; policy: EffectiveAiPolicy | null; usage: UsageRow[]; logs: RuntimeLog[]; resources: ProjectResource[]; metricScopes: MetricScope[]; metricScopeKey: string; onMetricScopeChange: (value: string) => void; deployments: Deployment[]; delivery: DeliveryState | null; project: Project; currentUserId: string; role: Role; onDeploy: (profileId: string, branch: string) => Promise<void>; onApproveDeployment: (id: string) => Promise<void>; onDeploymentAction: (id: string, action: "execute" | "rollback") => Promise<void>; onRefresh: () => Promise<void>; onProjectAction: (action: "archive" | "restore" | "trash" | "purge", body?: unknown) => Promise<void>; onSaveResource: (input: Record<string, unknown>) => Promise<void>; onProvisionDatabase: () => Promise<void>; onRemoveResource: (id: string) => Promise<void>; onError: (value: string) => void }) {
  const totals = useMemo(() => usage.reduce((sum, item) => ({ tokens: sum.tokens + item.totalTokens, cost: sum.cost + item.estimatedCostUsd, requests: sum.requests + item.requests }), { tokens: 0, cost: 0, requests: 0 }), [usage]);
  const [deploymentProfileId, setDeploymentProfileId] = useState("");
  const [deploymentBranch, setDeploymentBranch] = useState(project.activeBranch);
  async function submitResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const kind = String(data.get("kind")); const url = String(data.get("url") ?? "");
    try { await onSaveResource({ kind, name: String(data.get("name")).trim().toUpperCase(), environment: data.get("environment"), value: data.get("value") || undefined, config: url ? { [kind === "git" ? "repositoryUrl" : "url"]: url } : {} }); form.reset(); }
    catch (error) { onError(error instanceof Error ? error.message : "Resource update failed"); }
  }
  async function submitGit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    try { await api(`/api/projects/${project.id}/git`, { method: "PUT", body: JSON.stringify({ repositoryUrl: data.get("repositoryUrl"), defaultBranch: data.get("defaultBranch"), branchPrefix: data.get("branchPrefix"), syncMode: data.get("syncMode"), credentialType: data.get("credentialType"), credential: data.get("credential") || undefined, enabled: true }) }); await onRefresh(); }
    catch (error) { onError(error instanceof Error ? error.message : "Git configuration failed"); }
  }
  async function submitWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try { await api(`/api/projects/${project.id}/workers`, { method: "POST", body: JSON.stringify({ name: data.get("name"), baseBranch: data.get("baseBranch"), workingBranch: data.get("workingBranch"), autoPush: data.get("autoPush") === "on" }) }); form.reset(); await onRefresh(); }
    catch (error) { onError(error instanceof Error ? error.message : "Worker creation failed"); }
  }
  const selectedDeploymentProfile = deploymentProfileId || delivery?.deploymentProfiles[0]?.id || "";
  return <section className="panel detailsPanel"><div className="tabbar" role="tablist" aria-label="Project details"><TabButton icon={<FileCode2 size={16} />} label="Files" tab="files" active={activeTab} set={onChangeTab} /><TabButton icon={<ScrollText size={16} />} label="Logs" tab="logs" active={activeTab} set={onChangeTab} /><TabButton icon={<Plug size={16} />} label="Resources" tab="resources" active={activeTab} set={onChangeTab} /><TabButton icon={<GitBranch size={16} />} label="Git" tab="git" active={activeTab} set={onChangeTab} /><TabButton icon={<Gauge size={16} />} label="Metrics" tab="metrics" active={activeTab} set={onChangeTab} /><TabButton icon={<Rocket size={16} />} label="Deploy" tab="deploy" active={activeTab} set={onChangeTab} /></div>
    {activeTab === "files" && <div className="tabContent"><div className="infoRow"><span>Run</span><strong><GitBranch size={14} />{run?.commitSha?.slice(0, 8) ?? run?.id.slice(0, 8) ?? "No run"}</strong></div><div className="fileList">{run?.files.length ? run.files.map((file) => <article className="fileItem" key={file.path}><div><strong>{file.path}</strong><p>{file.summary}</p></div><span>+{file.additions} -{file.deletions}</span></article>) : <p className="mutedText">Changed files appear after a run completes.</p>}</div></div>}
    {activeTab === "logs" && <div className="tabContent"><div className="infoRow"><span>Runtime and verification</span><strong>{logs.length}</strong></div><div className="logList">{logs.length ? logs.map((log) => <article className={`logItem ${log.level}`} key={log.id}><div><span>{log.source}</span><time>{new Date(log.createdAt).toLocaleTimeString()}</time></div><p>{log.message}</p></article>) : <p className="mutedText">Logs will appear as the preview and verification run.</p>}</div></div>}
    {activeTab === "resources" && <div className="tabContent"><button className="secondaryButton" onClick={() => void onProvisionDatabase().catch((error) => onError(error instanceof Error ? error.message : "Database provisioning failed"))}><Database size={16} />Provision PostgreSQL</button><div className="resourceList">{resources.map((resource) => <article className="resourceItem" key={resource.id}><span className="resourceIcon">{resource.kind === "database" ? <Database size={16} /> : <KeyRound size={16} />}</span><div><strong>{resource.name}</strong><small>{resource.kind} · {resource.environment}</small></div><button className="miniIcon" title={`Delete ${resource.name}`} onClick={() => void onRemoveResource(resource.id).catch((error) => onError(error instanceof Error ? error.message : "Resource deletion failed"))}><Trash2 size={15} /></button></article>)}</div><form className="resourceForm" onSubmit={(event) => void submitResource(event)}><label>Kind<select name="kind"><option value="secret">Secret</option><option value="api">API key</option><option value="smtp">SMTP</option><option value="git">Git repository</option><option value="service">Service</option></select></label><label>Environment variable<input name="name" pattern="[A-Z][A-Z0-9_]*" placeholder="SERVICE_API_KEY" required /></label><label>Environment<select name="environment"><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option><option value="all">All</option></select></label><label>Secret value<input name="value" type="password" autoComplete="off" /></label><label className="wideField">Service or repository URL<input name="url" type="url" placeholder="https://..." /></label><button className="primaryButton"><Plus size={16} />Save resource</button></form></div>}
    {activeTab === "git" && <div className="tabContent"><div className="infoRow"><span>Active branch</span><strong><GitBranch size={14} />{delivery?.activeBranch ?? project.activeBranch}</strong></div><label className="fieldLabel">Stack profile<select value={delivery?.stackProfileId ?? ""} onChange={(event) => void api(`/api/projects/${project.id}/stack-profile`, { method: "POST", body: JSON.stringify({ profileId: event.target.value || null }) }).then(onRefresh).catch(showError(onError))}><option value="">Inherited default</option>{delivery?.stackProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} ({profile.scopeType})</option>)}</select></label><form className="resourceForm" onSubmit={(event) => void submitGit(event)}><label className="wideField">HTTPS repository<input name="repositoryUrl" type="url" defaultValue={delivery?.git?.repositoryUrl} required /></label><label>Default branch<input name="defaultBranch" defaultValue={delivery?.git?.defaultBranch ?? "main"} required /></label><label>Agent branch prefix<input name="branchPrefix" defaultValue={delivery?.git?.branchPrefix ?? "vibeable/"} /></label><label>Sync mode<select name="syncMode" defaultValue={delivery?.git?.syncMode ?? "mirror"}><option value="mirror">Mirror branches</option><option value="source">Source branch only</option></select></label><label>Credential type<select name="credentialType" defaultValue={delivery?.git?.credentialType ?? "bearer"}><option value="bearer">Bearer token</option><option value="basic">username:token</option></select></label><label className="wideField">Credential<input name="credential" type="password" autoComplete="off" placeholder={delivery?.git?.hasCredential ? "Leave blank to retain" : "Optional"} /></label><button className="primaryButton"><UploadCloud size={16} />Save Git</button></form>{delivery?.git && <div className="deployActions"><button className="secondaryButton" onClick={() => void api(`/api/projects/${project.id}/git/sync`, { method: "POST", body: JSON.stringify({ direction: "pull", branch: delivery.activeBranch }) }).then(onRefresh).catch(showError(onError))}><RotateCcw size={16} />Pull</button><button className="secondaryButton" onClick={() => void api(`/api/projects/${project.id}/git/sync`, { method: "POST", body: JSON.stringify({ direction: "push", branch: delivery.activeBranch }) }).then(onRefresh).catch(showError(onError))}><UploadCloud size={16} />Push</button></div>}<div className="sectionTitle">Branch workers</div><div className="resourceList">{delivery?.workers.map((worker) => <article className="resourceItem" key={worker.id}><span className="resourceIcon"><GitBranch size={16} /></span><div><strong>{worker.name}</strong><small>{worker.workingBranch} · {worker.status} · {worker.autoPush ? "auto-push" : "local"}</small></div>{worker.status === "active" && <button className="miniIcon" title="Stop worker" onClick={() => void api(`/api/projects/${project.id}/workers/${worker.id}`, { method: "DELETE" }).then(onRefresh).catch(showError(onError))}><X size={15} /></button>}</article>)}</div><form className="resourceForm" onSubmit={(event) => void submitWorker(event)}><label>Name<input name="name" placeholder="Checkout redesign" required /></label><label>Base branch<select name="baseBranch" defaultValue={delivery?.activeBranch}>{delivery?.branches.map((branch) => <option key={branch}>{branch}</option>)}</select></label><label className="wideField">Working branch<input name="workingBranch" placeholder="feature/checkout-redesign" required /></label><label className="checkboxLabel"><input name="autoPush" type="checkbox" defaultChecked />Auto-push</label><button className="primaryButton"><Plus size={16} />Spawn worker</button></form>{delivery && delivery.branches.length > 1 && <form className="resourceForm" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void api(`/api/projects/${project.id}/branches/promote`, { method: "POST", body: JSON.stringify({ branch: data.get("branch"), destination: data.get("destination"), push: true }) }).then(onRefresh).catch(showError(onError)); }}><label>Promote<select name="branch">{delivery.branches.filter((branch) => branch !== delivery.activeBranch).map((branch) => <option key={branch}>{branch}</option>)}</select></label><label>Into<select name="destination" defaultValue={delivery.activeBranch}>{delivery.branches.map((branch) => <option key={branch}>{branch}</option>)}</select></label><button className="secondaryButton"><GitBranch size={16} />Promote branch</button></form>}<div className="dangerZone"><button className="secondaryButton" onClick={() => void onProjectAction("archive", { offload: false }).catch(showError(onError))}><Archive size={16} />Archive</button><button className="secondaryButton" disabled={!delivery?.git} onClick={() => void onProjectAction("archive", { offload: true }).catch(showError(onError))}><UploadCloud size={16} />Offload to Git</button><button className="dangerButton" onClick={() => window.confirm(`Move ${project.name} to trash?`) && void onProjectAction("trash").catch(showError(onError))}><Trash2 size={16} />Move to trash</button></div></div>}
    {activeTab === "metrics" && <div className="tabContent"><label className="selectShell fullWidth"><select aria-label="Usage scope" value={metricScopeKey} onChange={(event) => onMetricScopeChange(event.target.value)}>{metricScopes.map((scope) => <option key={`${scope.scope}:${scope.id}`} value={`${scope.scope}:${scope.id}`}>{scope.scope}: {scope.label}</option>)}</select><ChevronDown size={16} /></label><MetricTile icon={<CircleDollarSign size={18} />} label="Usage" value={formatTokens(totals.tokens)} detail={`$${totals.cost.toFixed(2)} across ${totals.requests} requests`} />{policy && <MetricTile icon={<ShieldCheck size={18} />} label="Boundary" value={formatTokens(policy.monthlyTokenLimit)} detail={`$${policy.monthlyCostLimitUsd.toLocaleString()} monthly cap`} />}<UsageBars values={usage} /></div>}
    {activeTab === "deploy" && <div className="tabContent"><MetricTile icon={<Cloud size={18} />} label="Environment" value={project.environment} detail="Exact-commit, profile-driven delivery" />{delivery?.deploymentProfiles.length ? <div className="deployComposer"><label className="fieldLabel">Deployment profile<select value={selectedDeploymentProfile} onChange={(event) => setDeploymentProfileId(event.target.value)}>{delivery.deploymentProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.adapter} · {profile.environment}</option>)}</select></label><label className="fieldLabel">Branch<select value={deploymentBranch} onChange={(event) => setDeploymentBranch(event.target.value)}>{delivery.branches.map((branch) => <option key={branch}>{branch}</option>)}</select></label><button className="primaryButton" onClick={() => void onDeploy(selectedDeploymentProfile, deploymentBranch)}><Rocket size={16} />Plan deployment</button></div> : <p className="mutedText">An administrator must create a deployment profile for this team or project.</p>}<div className="checkList">{deployments.map((deployment) => <article className="deploymentItem" key={deployment.id}><div className="deploymentHeading"><span className={`checkIcon ${deployment.status === "deployed" ? "passed" : "pending"}`}>{deployment.status === "deployed" && <Check size={14} />}</span><div><strong>{deployment.profileName ?? deployment.environment}</strong><small>{deployment.adapter} · {deployment.branch} · {deployment.status}</small></div></div><div className="deploymentEvents">{deployment.events?.map((event) => <p className={event.level} key={event.id}><span>{event.type}</span>{event.message}</p>)}</div><div className="deployActions">{deployment.status === "waiting_approval" && deployment.requestedBy !== currentUserId && ["owner", "admin", "reviewer"].includes(role) && <button className="secondaryButton" onClick={() => void onApproveDeployment(deployment.id)}><ShieldCheck size={15} />Approve</button>}{deployment.status === "approved" && ["owner", "admin", "developer"].includes(role) && <button className="primaryButton" onClick={() => void onDeploymentAction(deployment.id, "execute").catch(showError(onError))}><Play size={15} />Execute</button>}{deployment.status === "deployed" && ["owner", "admin", "developer"].includes(role) && <button className="secondaryButton" onClick={() => void onDeploymentAction(deployment.id, "rollback").catch(showError(onError))}><RotateCcw size={15} />Rollback</button>}</div></article>)}</div></div>}
  </section>;
}

interface ProviderSetting { id: string; name: string; baseUrl: string; defaultModel: string; allowedModels: string[]; inputCostPerMillion: number; outputCostPerMillion: number; hasApiKey: boolean; enabled: boolean }
interface TeamSetting { id: string; name: string; slug: string; memberCount: number }
interface UserSetting { id: string; name: string; email: string; role: Role; teams: Array<{ id: string; name: string; role: Role }> }
interface PolicySetting { id: string; scope_type: string; scope_id: string; default_model: string; monthly_token_limit: string; monthly_cost_limit_usd: string }
interface HookSetting { id: string; scope_type: string; phase: string; title: string; priority: number }
interface StackProfileSetting { id: string; scopeType: "global" | "team" | "project"; scopeId: string; name: string; description: string; rules: Record<string, string[]>; isDefault: boolean; enabled: boolean }
interface DeploymentProfileSetting { id: string; scopeType: "team" | "project"; scopeId: string; name: string; adapter: string; environment: string; config: Record<string, unknown>; resourceNames: string[]; enabled: boolean }
type DeliveryAdapter = "kubernetes" | "helm" | "docker_swarm" | "compose" | "gitops" | "webhook";

function defaultDeploymentConfig(adapter: DeliveryAdapter) {
  const defaults: Record<DeliveryAdapter, Record<string, string>> = {
    kubernetes: { manifestPath: "deploy/kubernetes.yaml" },
    helm: { chartPath: "deploy/chart", release: "app", namespace: "default" },
    docker_swarm: { composePath: "compose.yaml", stack: "app" },
    compose: { composePath: "compose.yaml", projectName: "app" },
    gitops: { branch: "main" },
    webhook: { url: "https://deploy.example.com/hooks/vibeable" }
  };
  return JSON.stringify(defaults[adapter], null, 2);
}

function GovernancePanel({ mode, session, projects, onError }: { mode: "teams" | "policy"; session: Session; projects: Project[]; onError: (value: string) => void }) {
  const [providers, setProviders] = useState<ProviderSetting[]>([]);
  const [teams, setTeams] = useState<TeamSetting[]>([]);
  const [users, setUsers] = useState<UserSetting[]>([]);
  const [policies, setPolicies] = useState<PolicySetting[]>([]);
  const [hooks, setHooks] = useState<HookSetting[]>([]);
  const [scope, setScope] = useState<"global" | "team" | "user" | "project">("global");
  const [hookScope, setHookScope] = useState<"global" | "team">("global");
  const [editingProvider, setEditingProvider] = useState<ProviderSetting | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const load = async () => {
      if (mode === "teams") {
        const teamResult = await api<{ teams: TeamSetting[] }>("/api/admin/teams");
        setTeams(teamResult.teams);
        if (session.user.role === "owner") setUsers((await api<{ users: UserSetting[] }>("/api/admin/users")).users);
      } else {
        const [providerResult, policyResult, hookResult, teamResult] = await Promise.all([
          api<{ providers: ProviderSetting[] }>("/api/admin/providers"),
          api<{ policies: PolicySetting[] }>("/api/admin/policies"),
          api<{ hooks: HookSetting[] }>("/api/admin/hooks"),
          api<{ teams: TeamSetting[] }>("/api/admin/teams")
        ]);
        setProviders(providerResult.providers); setPolicies(policyResult.policies); setHooks(hookResult.hooks); setTeams(teamResult.teams);
        if (session.user.role === "owner") setUsers((await api<{ users: UserSetting[] }>("/api/admin/users")).users);
      }
    };
    void load().catch(showError(onError));
  }, [mode, onError, revision, session.user.role]);

  async function submit(path: string, event: FormEvent<HTMLFormElement>, transform: (data: FormData) => unknown = Object.fromEntries, method = "POST") {
    event.preventDefault(); onError(""); const form = event.currentTarget;
    try { await api(path, { method, body: JSON.stringify(transform(new FormData(form))) }); form.reset(); setEditingProvider(null); setRevision((value) => value + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Settings update failed"); }
  }

  if (mode === "teams") return <section className="governancePanel">
    <section className="settingsSection"><div className="settingsHeading"><div><h2>Teams</h2><p>Project access and scoped AI controls follow team membership.</p></div></div>
      <div className="settingsTable">{teams.map((team) => <div className="settingsRow" key={team.id}><span className="settingIcon"><Users size={17} /></span><div><strong>{team.name}</strong><small>{team.slug}</small></div><span>{team.memberCount} members</span></div>)}</div>
      <form className="settingsForm compact" onSubmit={(event) => void submit("/api/admin/teams", event)}><label>Team name<input name="name" required minLength={2} /></label><button className="primaryButton"><Plus size={16} />Add team</button></form>
    </section>
    {session.user.role === "owner" && <section className="settingsSection"><div className="settingsHeading"><div><h2>Users</h2><p>Organization roles are enforced by the API on every protected action.</p></div></div>
      <div className="settingsTable">{users.map((user) => <div className="settingsRow" key={user.id}><span className="settingIcon"><Users size={17} /></span><div><strong>{user.name}</strong><small>{user.email} · {user.teams.map((team) => team.name).join(", ") || "No team"}</small></div><StatusPill label={user.role} tone="blue" /></div>)}</div>
      <form className="settingsForm" onSubmit={(event) => void submit("/api/admin/users", event, (data) => ({ name: data.get("name"), email: data.get("email"), password: data.get("password"), role: data.get("role"), teamId: data.get("teamId") || undefined }))}><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Temporary password<input name="password" type="password" minLength={12} required /></label><label>Role<select name="role"><option value="developer">Developer</option><option value="reviewer">Reviewer</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><label>Team<select name="teamId"><option value="">No team</option>{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><button className="primaryButton"><Plus size={16} />Add user</button></form>
      {users.length > 0 && teams.length > 0 && <form className="settingsForm compact" onSubmit={(event) => void submit("/api/admin/memberships", event, (data) => ({ userId: data.get("userId"), teamId: data.get("teamId"), role: data.get("role") }))}><label>User<select name="userId">{users.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}</select></label><label>Team<select name="teamId">{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><label>Team role<select name="role"><option value="developer">Developer</option><option value="reviewer">Reviewer</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><button className="secondaryButton"><Users size={16} />Assign team</button></form>}
    </section>}
  </section>;

  const scopeTargets = scope === "global" ? [{ id: session.user.organizationId, name: session.user.organizationName }] : scope === "team" ? session.teams : scope === "user" ? users : projects;
  return <section className="governancePanel">
    <section className="settingsSection"><div className="settingsHeading"><div><h2>AI providers</h2><p>Approved OpenAI-compatible endpoints and cost metadata.</p></div></div>
      <div className="settingsTable">{providers.map((provider) => <div className="settingsRow" key={provider.id}><span className="settingIcon"><Bot size={17} /></span><div><strong>{provider.name}</strong><small>{provider.baseUrl} · {provider.enabled ? "enabled" : "disabled"}</small></div><span>{provider.defaultModel}</span><button className="miniIcon" title={`Edit ${provider.name}`} onClick={() => setEditingProvider(provider)}><Pencil size={15} /></button></div>)}</div>
      <form key={editingProvider?.id ?? "new"} className="settingsForm" onSubmit={(event) => void submit(editingProvider ? `/api/admin/providers/${editingProvider.id}` : "/api/admin/providers", event, (data) => ({ name: data.get("name"), baseUrl: data.get("baseUrl"), apiKey: data.get("apiKey") || undefined, defaultModel: data.get("defaultModel"), allowedModels: String(data.get("allowedModels")).split(",").map((value) => value.trim()).filter(Boolean), inputCostPerMillion: Number(data.get("inputCostPerMillion")), outputCostPerMillion: Number(data.get("outputCostPerMillion")), ...(editingProvider ? { enabled: data.get("enabled") === "on" } : {}) }), editingProvider ? "PATCH" : "POST")}><label>Name<input name="name" defaultValue={editingProvider?.name} required /></label><label>Endpoint<input name="baseUrl" type="url" placeholder="https://.../v1" defaultValue={editingProvider?.baseUrl} required /></label><label>API key<input name="apiKey" type="password" placeholder={editingProvider?.hasApiKey ? "Leave blank to keep current key" : ""} /></label><label>Default model<input name="defaultModel" defaultValue={editingProvider?.defaultModel} required /></label><label>Allowed models<input name="allowedModels" placeholder="model-a, model-b" defaultValue={editingProvider?.allowedModels.join(", ")} required /></label><label>Input $ / 1M<input name="inputCostPerMillion" type="number" min="0" step="0.000001" defaultValue={editingProvider?.inputCostPerMillion ?? 0} required /></label><label>Output $ / 1M<input name="outputCostPerMillion" type="number" min="0" step="0.000001" defaultValue={editingProvider?.outputCostPerMillion ?? 0} required /></label>{editingProvider && <label className="checkboxLabel"><input name="enabled" type="checkbox" defaultChecked={editingProvider.enabled} />Enabled</label>}<button className="primaryButton">{editingProvider ? <Pencil size={16} /> : <Plus size={16} />}{editingProvider ? "Update provider" : "Add provider"}</button>{editingProvider && <button className="secondaryButton" type="button" onClick={() => setEditingProvider(null)}><X size={16} />Cancel</button>}</form>
    </section>
    <section className="settingsSection"><div className="settingsHeading"><div><h2>Scoped policies</h2><p>Global boundaries are intersected with team, user, and project choices.</p></div></div>
      <div className="settingsTable">{policies.map((item) => <div className="settingsRow" key={item.id}><span className="settingIcon"><ShieldCheck size={17} /></span><div><strong>{item.scope_type}</strong><small>{item.default_model}</small></div><span>{formatTokens(Number(item.monthly_token_limit))} / ${item.monthly_cost_limit_usd}</span></div>)}</div>
      <form className="settingsForm" onSubmit={(event) => void submit("/api/admin/policies", event, (data) => { const providerId = String(data.get("defaultProviderId")); const model = String(data.get("defaultModel")); const allowedProviderIds = data.getAll("allowedProviderIds").map(String); return { scopeType: data.get("scopeType"), scopeId: data.get("scopeId"), defaultProviderId: providerId, defaultModel: model, allowedProviderIds: allowedProviderIds.includes(providerId) ? allowedProviderIds : [...allowedProviderIds, providerId], allowedModels: String(data.get("allowedModels")).split(",").map((value) => value.trim()).filter(Boolean), monthlyTokenLimit: Number(data.get("monthlyTokenLimit")), monthlyCostLimitUsd: Number(data.get("monthlyCostLimitUsd")), allowUserOverride: data.get("allowUserOverride") === "on", requireApprovalFor: data.getAll("requireApprovalFor") }; })}><label>Scope<select name="scopeType" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="global">Global</option><option value="team">Team</option>{session.user.role === "owner" && <option value="user">User</option>}<option value="project">Project</option></select></label><label>Target<select name="scopeId">{scopeTargets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label><label>Default provider<select name="defaultProviderId">{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label><label>Default model<input name="defaultModel" required /></label><fieldset className="wideField"><legend>Allowed providers</legend>{providers.map((provider) => <label className="checkboxLabel" key={provider.id}><input name="allowedProviderIds" type="checkbox" value={provider.id} defaultChecked />{provider.name}</label>)}</fieldset><label>Allowed models<input name="allowedModels" placeholder="model-a, model-b" required /></label><label>Monthly tokens<input name="monthlyTokenLimit" type="number" min="1" defaultValue="1000000" required /></label><label>Monthly cost USD<input name="monthlyCostLimitUsd" type="number" min="0" step="0.01" defaultValue="100" required /></label><label className="checkboxLabel"><input name="allowUserOverride" type="checkbox" />Allow user defaults</label><fieldset className="wideField"><legend>Approval required</legend>{phases.map((item) => <label className="checkboxLabel" key={item}><input name="requireApprovalFor" type="checkbox" value={item} defaultChecked={["database_migration", "production_deploy_prepare"].includes(item)} />{item}</label>)}</fieldset><button className="primaryButton"><ShieldCheck size={16} />Save policy</button></form>
    </section>
    <section className="settingsSection"><div className="settingsHeading"><div><h2>Prompt hooks</h2><p>Inject company and stack rules at specific agent lifecycle phases.</p></div></div>
      <div className="settingsTable">{hooks.map((hook) => <div className="settingsRow" key={hook.id}><span className="settingIcon"><Code2 size={17} /></span><div><strong>{hook.title}</strong><small>{hook.scope_type} · {hook.phase}</small></div><span>Priority {hook.priority}</span></div>)}</div>
      <form className="settingsForm" onSubmit={(event) => void submit("/api/admin/hooks", event, (data) => ({ scopeType: data.get("scopeType"), scopeId: data.get("scopeId"), phase: data.get("phase"), priority: Number(data.get("priority")), mandatory: data.get("mandatory") === "on", title: data.get("title"), prompt: data.get("prompt") }))}><label>Scope<select name="scopeType" value={hookScope} onChange={(event) => setHookScope(event.target.value as typeof hookScope)}><option value="global">Global</option>{session.teams[0] && <option value="team">Team</option>}</select></label><label>Target<select name="scopeId">{hookScope === "global" ? <option value={session.user.organizationId}>{session.user.organizationName}</option> : session.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><label>Phase<select name="phase">{phases.map((item) => <option key={item}>{item}</option>)}</select></label><label>Title<input name="title" required /></label><label>Priority<input name="priority" type="number" defaultValue="0" required /></label><label className="wideField">Prompt<textarea name="prompt" rows={3} required /></label><label className="checkboxLabel"><input name="mandatory" type="checkbox" />Mandatory</label><button className="primaryButton"><Plus size={16} />Add hook</button></form>
    </section>
  </section>;
}

function DeliveryGovernancePanel({ session, projects, onError }: { session: Session; projects: Project[]; onError: (value: string) => void }) {
  const [teams, setTeams] = useState<TeamSetting[]>([]);
  const [stacks, setStacks] = useState<StackProfileSetting[]>([]);
  const [profiles, setProfiles] = useState<DeploymentProfileSetting[]>([]);
  const [stackScope, setStackScope] = useState<"global" | "team" | "project">("team");
  const [deployScope, setDeployScope] = useState<"team" | "project">("team");
  const [deployAdapter, setDeployAdapter] = useState<DeliveryAdapter>("kubernetes");
  const [deployConfig, setDeployConfig] = useState(defaultDeploymentConfig("kubernetes"));
  const [revision, setRevision] = useState(0);
  useEffect(() => { void Promise.all([
    api<{ teams: TeamSetting[] }>("/api/admin/teams"),
    api<{ profiles: StackProfileSetting[] }>("/api/admin/stack-profiles"),
    api<{ profiles: DeploymentProfileSetting[] }>("/api/admin/deployment-profiles")
  ]).then(([teamResult, stackResult, profileResult]) => { setTeams(teamResult.teams); setStacks(stackResult.profiles); setProfiles(profileResult.profiles); }).catch(showError(onError)); }, [onError, revision]);
  const stackTargets = stackScope === "global" ? [{ id: session.user.organizationId, name: session.user.organizationName }] : stackScope === "team" ? teams : projects;
  const deployTargets = deployScope === "team" ? teams : projects;
  async function submitStack(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const list = (name: string) => String(data.get(name) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    try { await api("/api/admin/stack-profiles", { method: "POST", body: JSON.stringify({ scopeType: data.get("scopeType"), scopeId: data.get("scopeId"), name: data.get("name"), description: data.get("description"), isDefault: data.get("isDefault") === "on", enabled: true, rules: { allowedLanguages: list("allowedLanguages"), allowedFrameworks: list("allowedFrameworks"), allowedPackageManagers: list("allowedPackageManagers"), allowedBaseImages: list("allowedBaseImages"), requiredFiles: list("requiredFiles"), requiredDependencies: list("requiredDependencies"), forbiddenDependencies: list("forbiddenDependencies"), requiredScripts: list("requiredScripts") } }) }); form.reset(); setRevision((value) => value + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Stack profile creation failed"); }
  }
  async function submitDeploymentProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try { const config = JSON.parse(String(data.get("config") || "{}")); await api("/api/admin/deployment-profiles", { method: "POST", body: JSON.stringify({ scopeType: data.get("scopeType"), scopeId: data.get("scopeId"), name: data.get("name"), adapter: data.get("adapter"), environment: data.get("environment"), config, resourceNames: String(data.get("resourceNames") ?? "").split(",").map((value) => value.trim()).filter(Boolean), enabled: true }) }); form.reset(); setDeployAdapter("kubernetes"); setDeployConfig(defaultDeploymentConfig("kubernetes")); setRevision((value) => value + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Deployment profile creation failed"); }
  }
  return <section className="governancePanel"><section className="settingsSection"><div className="settingsHeading"><div><h2>Enforced technology profiles</h2><p>Generation is prompted with these constraints and the workspace is rejected when validation fails.</p></div></div><div className="settingsTable">{stacks.map((profile) => <div className="settingsRow" key={profile.id}><span className="settingIcon"><Code2 size={17} /></span><div><strong>{profile.name}</strong><small>{profile.scopeType} · {profile.description || "No description"}</small></div><span>{profile.isDefault ? "default" : "selectable"}</span></div>)}</div><form className="settingsForm" onSubmit={(event) => void submitStack(event)}><label>Scope<select name="scopeType" value={stackScope} onChange={(event) => setStackScope(event.target.value as typeof stackScope)}><option value="global">Global</option><option value="team">Team</option><option value="project">Project</option></select></label><label>Target<select name="scopeId">{stackTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><label>Name<input name="name" required /></label><label>Description<input name="description" /></label><label>Languages<input name="allowedLanguages" placeholder="typescript, go" /></label><label>Frameworks<input name="allowedFrameworks" placeholder="react, fastify" /></label><label>Package managers<input name="allowedPackageManagers" placeholder="pnpm" /></label><label>Base images<input name="allowedBaseImages" placeholder="node, nginx" /></label><label>Required files<input name="requiredFiles" placeholder="Dockerfile, README.md" /></label><label>Required dependencies<input name="requiredDependencies" placeholder="fastify" /></label><label>Forbidden dependencies<input name="forbiddenDependencies" placeholder="left-pad" /></label><label>Required scripts<input name="requiredScripts" placeholder="build, test" /></label><label className="checkboxLabel"><input name="isDefault" type="checkbox" />Default for scope</label><button className="primaryButton"><Plus size={16} />Add stack profile</button></form></section><section className="settingsSection"><div className="settingsHeading"><div><h2>Deployment profiles</h2><p>Fixed adapters support Kubernetes, Helm, Docker Swarm, Compose, GitOps, and authenticated webhooks.</p></div></div><div className="settingsTable">{profiles.map((profile) => <div className="settingsRow" key={profile.id}><span className="settingIcon"><Rocket size={17} /></span><div><strong>{profile.name}</strong><small>{profile.scopeType} · {profile.adapter}</small></div><StatusPill label={profile.environment} tone={profile.environment === "production" ? "amber" : "blue"} /></div>)}</div><form className="settingsForm" onSubmit={(event) => void submitDeploymentProfile(event)}><label>Scope<select name="scopeType" value={deployScope} onChange={(event) => setDeployScope(event.target.value as typeof deployScope)}><option value="team">Team</option><option value="project">Project</option></select></label><label>Target<select name="scopeId">{deployTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><label>Name<input name="name" required /></label><label>Adapter<select name="adapter" value={deployAdapter} onChange={(event) => { const adapter = event.target.value as DeliveryAdapter; setDeployAdapter(adapter); setDeployConfig(defaultDeploymentConfig(adapter)); }}><option value="kubernetes">Kubernetes</option><option value="helm">Helm</option><option value="docker_swarm">Docker Swarm</option><option value="compose">Docker Compose</option><option value="gitops">GitOps</option><option value="webhook">Webhook</option></select></label><label>Environment<select name="environment"><option value="staging">Staging</option><option value="production">Production</option></select></label><label className="wideField">Adapter config (JSON)<textarea name="config" rows={4} value={deployConfig} onChange={(event) => setDeployConfig(event.target.value)} required /></label><label className="wideField">Injected resource names<input name="resourceNames" placeholder="DATABASE_URL, SMTP_PASSWORD" /></label><button className="primaryButton"><Plus size={16} />Add deployment profile</button></form></section></section>;
}

function LifecycleProject({ project, onRestore, onPurge }: { project: Project; onRestore: () => Promise<void>; onPurge: () => Promise<void> }) {
  return <section className="emptyProject"><Archive size={32} /><h2>{project.deletedAt ? "Project is in trash" : project.offloadedAt ? "Project is offloaded to Git" : "Project is archived"}</h2><p className="mutedText">{project.deletedAt ? "Restore it to continue or permanently purge its database records and workspace." : "Restore it to resume builds, previews, and deployments."}</p><div className="deployActions"><button className="primaryButton" onClick={() => void onRestore()}><RotateCcw size={17} />Restore project</button>{project.deletedAt && <button className="dangerButton" onClick={() => window.confirm(`Permanently purge ${project.name}? This cannot be undone.`) && void onPurge()}><Trash2 size={17} />Purge permanently</button>}</div></section>;
}

function ServiceUnavailable({ message, retry }: { message: string; retry: () => Promise<void> }) {
  return <main className="authShell"><section className="authPanel serviceState"><span className="brandMark"><Terminal size={20} /></span><h1>Service unavailable</h1><p>{message}</p><button className="primaryButton" onClick={() => void retry()}><RefreshCw size={17} />Retry</button></section></main>;
}

function ViewportButton({ value, active, set, icon }: { value: ViewportMode; active: ViewportMode; set: (value: ViewportMode) => void; icon: ReactNode }) { return <button type="button" className={active === value ? "active" : ""} aria-pressed={active === value} onClick={() => set(value)} title={`${value} viewport`}>{icon}</button>; }
function TabButton({ icon, label, tab, active, set }: { icon: ReactNode; label: string; tab: RightPanelTab; active: RightPanelTab; set: (value: RightPanelTab) => void }) { return <button type="button" className={active === tab ? "active" : ""} aria-selected={active === tab} role="tab" onClick={() => set(tab)}>{icon}<span>{label}</span></button>; }
function StatusPill({ label, tone }: { label: string; tone: "blue" | "green" | "amber" }) { return <span className={`statusPill ${tone}`}><i />{label}</span>; }
function MetricTile({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) { return <article className="metricTile"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>; }
function UsageBars({ values }: { values: UsageRow[] }) { const grouped = Object.values(values.reduce<Record<string, { model: string; tokens: number }>>((all, row) => { const item = all[row.model] ?? { model: row.model, tokens: 0 }; item.tokens += row.totalTokens; all[row.model] = item; return all; }, {})); const max = Math.max(...grouped.map((item) => item.tokens), 1); return <section className="usageGroup"><div className="sectionTitle">Models</div>{grouped.map((item) => <div className="usageBar" key={item.model}><div><strong>{item.model}</strong><span>{formatTokens(item.tokens)}</span></div><progress value={item.tokens} max={max} /></div>)}</section>; }
function EmptyProject({ onCreate }: { onCreate: () => void }) { return <section className="emptyProject"><Boxes size={32} /><h2>No projects yet</h2><button className="primaryButton" onClick={onCreate}><Plus size={17} />Create project</button></section>; }
function useElapsed(run: Run | undefined, active: boolean) { const [now, setNow] = useState(Date.now()); useEffect(() => { if (!active) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [active]); return run ? Math.max(0, now - new Date(run.createdAt).getTime()) : 0; }
function formatElapsed(milliseconds: number) { const seconds = Math.floor(milliseconds / 1000); const minutes = Math.floor(seconds / 60); return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }
function stageState(stage: string, current?: string) { const order = ["planning", "editing", "testing", "ready"]; if (current === "failed") return "failed"; const currentIndex = order.indexOf(current ?? ""); const stageIndex = order.indexOf(stage); return stageIndex < currentIndex ? "complete" : stageIndex === currentIndex ? "active" : ""; }
function formatTokens(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value); }
function getInitials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U"; }
function showError(set: (value: string) => void) { return (error: unknown) => set(error instanceof Error ? error.message : "Request failed"); }
