import {
  Activity, Bot, Boxes, Check, ChevronDown, CircleDollarSign, Cloud, Code2, FileCode2,
  Gauge, GitBranch, LayoutDashboard, Lock, LogOut, MessageSquare, Monitor, Play, Plus,
  Menu, RefreshCw, Rocket, ShieldCheck, Smartphone, Tablet, Terminal, Users, X, Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { AgentPhase, EffectiveAiPolicy, Role } from "./domain/types";

type RightPanelTab = "files" | "ai" | "metrics" | "deploy";
type ViewportMode = "desktop" | "tablet" | "mobile";

interface Session {
  user: { userId: string; organizationId: string; name: string; email: string; role: Role; organizationName: string };
  teams: Array<{ id: string; name: string; role: Role }>;
}
interface Project {
  id: string; name: string; slug: string; status: string; environment: string;
  teamId: string; teamName: string; updatedAt: string; previewUrl: string;
}
interface RunEvent { sequence: number; type: string; message: string; metadata: Record<string, unknown>; createdAt: string }
interface ChangedFile { path: string; additions: number; deletions: number; summary: string }
interface Run {
  id: string; userId: string; phase: AgentPhase; prompt: string; status: string; model?: string;
  commitSha?: string; totalTokens: number; estimatedCostUsd: number; createdAt: string; events: RunEvent[]; files: ChangedFile[];
}
interface UsageRow { day: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; requests: number }
interface MetricScope { scope: "global" | "team" | "user" | "project"; id: string; label: string }
interface Deployment { id: string; environment: string; status: string; requestedBy: string; approvedBy?: string; commitSha?: string; createdAt: string }

const phases: AgentPhase[] = [
  "project:create", "agent:before_plan", "agent:before_edit", "agent:after_edit", "agent:after_error",
  "agent:before_test", "agent:after_test_failure", "deploy:prepare", "deploy:preflight", "deploy:post_success",
  "deploy:post_failure", "summarize_logs", "classify_error", "generate_commit_message", "database_migration",
  "production_deploy_prepare"
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
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
        const setup = await api<{ needsBootstrap: boolean }>("/api/auth/setup-status");
        setNeedsBootstrap(setup.needsBootstrap);
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
  if (!session) return <AuthScreen bootstrap={needsBootstrap} onAuthenticated={loadSession} />;
  return <Builder session={session} onLogout={async () => { await api("/api/auth/logout", { method: "POST" }); await loadSession(); }} />;
}

function AuthScreen({ bootstrap, onAuthenticated }: { bootstrap: boolean; onAuthenticated: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
      <form onSubmit={submit}>
        {bootstrap && <><label>Organization<input name="organizationName" required minLength={2} /></label><label>Your name<input name="name" autoComplete="name" required /></label></>}
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" minLength={bootstrap ? 12 : 1} autoComplete={bootstrap ? "new-password" : "current-password"} required /></label>
        {bootstrap && <div className="providerSetup"><label>AI endpoint<input name="providerUrl" type="url" defaultValue="https://openrouter.ai/api/v1" required /></label><label>Model<input name="providerModel" defaultValue="openai/gpt-5-mini" required /></label><label>API key<input name="apiKey" type="password" autoComplete="off" /></label></div>}
        {error && <p className="formError" role="alert">{error}</p>}
        <button className="primaryButton" disabled={busy}>{busy ? "Working..." : bootstrap ? "Create workspace" : "Sign in"}</button>
      </form>
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
  const [projectTeams, setProjectTeams] = useState<Array<{ id: string; name: string }>>(session.teams);
  const [tab, setTab] = useState<RightPanelTab>("files");
  const [viewport, setViewport] = useState<ViewportMode>("desktop");
  const [phase, setPhase] = useState<AgentPhase>("agent:before_edit");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [view, setView] = useState<"builder" | "teams" | "policy">("builder");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    const result = await api<{ projects: Project[] }>("/api/projects"); setProjects(result.projects);
    setProjectId((current) => current || result.projects[0]?.id || "");
  }, []);
  const loadProjectTeams = useCallback(async () => {
    if (!["owner", "admin"].includes(session.user.role)) return setProjectTeams(session.teams);
    const result = await api<{ teams: Array<{ id: string; name: string }> }>("/api/admin/teams");
    setProjectTeams(result.teams);
  }, [session]);
  const refreshProject = useCallback(async () => {
    if (!projectId) return;
    const [runResult, policyResult, deploymentResult] = await Promise.all([
      api<{ runs: Run[] }>(`/api/projects/${projectId}/runs`),
      api<{ policy: EffectiveAiPolicy }>(`/api/projects/${projectId}/policy?phase=${encodeURIComponent(phase)}`),
      api<{ deployments: Deployment[] }>(`/api/projects/${projectId}/deployments`)
    ]);
    setRuns(runResult.runs); setPolicy(policyResult.policy); setDeployments(deploymentResult.deployments);
  }, [phase, projectId]);
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
  useEffect(() => {
    if (!activeRun || ["ready", "failed"].includes(activeRun.status)) return;
    const source = new EventSource(`/api/runs/${activeRun.id}/events`);
    source.onmessage = () => { void refreshProject(); void loadUsage(); };
    source.onerror = () => source.close();
    return () => source.close();
  }, [activeRun?.id, activeRun?.status, loadUsage, refreshProject]);

  async function startRun() {
    if (!projectId || !prompt.trim()) return;
    setError("");
    try { await api(`/api/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify({ prompt, phase }) }); setPrompt(""); await refreshProject(); }
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
  async function createDeployment(environment: "staging" | "production") {
    if (!projectId) return;
    setError("");
    try { await api(`/api/projects/${projectId}/deployments`, { method: "POST", body: JSON.stringify({ environment }) }); await refreshProject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Deployment request failed"); }
  }
  async function approveDeployment(deploymentId: string) {
    setError("");
    try { await api(`/api/deployments/${deploymentId}/approve`, { method: "POST" }); await refreshProject(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Deployment approval failed"); }
  }

  return <main className="appShell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brandLockup"><div className="brandMark"><Zap size={18} /></div><div><strong>Vibeable</strong><span>{session.user.organizationName}</span></div><button className="miniIcon sidebarClose" title="Close navigation" onClick={() => setSidebarOpen(false)}><X size={17} /></button></div>
      <nav className="navStack" aria-label="Main navigation"><button className={`navItem ${view === "builder" ? "active" : ""}`} onClick={() => { setView("builder"); setSidebarOpen(false); }}><LayoutDashboard size={18} />Builder</button><button className="navItem" onClick={() => { setView("builder"); setTab("metrics"); setSidebarOpen(false); }}><Gauge size={18} />Usage</button>{["owner", "admin"].includes(session.user.role) && <><button className={`navItem ${view === "teams" ? "active" : ""}`} onClick={() => { setView("teams"); setSidebarOpen(false); }}><Users size={18} />Teams & users</button><button className={`navItem ${view === "policy" ? "active" : ""}`} onClick={() => { setView("policy"); setSidebarOpen(false); }}><ShieldCheck size={18} />AI governance</button></>}</nav>
      <section className="sideSection"><div className="sectionTitleRow"><span className="sectionTitle">Projects</span><button className="miniIcon" title="Create project" onClick={() => setCreateOpen(!createOpen)}><Plus size={15} /></button></div>
        {createOpen && <form className="quickCreate" onSubmit={createProject}><input name="name" placeholder="Project name" required /><select name="teamId" required>{projectTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select><button className="primaryButton">Create</button></form>}
        <div className="projectList">{projects.map((project) => <button className={`projectButton ${project.id === projectId ? "selected" : ""}`} key={project.id} onClick={() => { setProjectId(project.id); setSidebarOpen(false); }}><span>{project.name}</span><small>{project.environment}</small></button>)}</div>
      </section>
      <div className="accountBlock"><div><strong>{session.user.name}</strong><span>{session.user.role}</span></div><button className="miniIcon" title="Sign out" onClick={() => void onLogout()}><LogOut size={16} /></button></div>
    </aside>
    <section className="workspace">
      <header className="topbar"><button className="iconButton mobileMenuButton" title="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button><div className="topbarTitle"><div className="eyebrow">{view === "builder" ? activeProject?.teamName ?? "Workspace" : "Organization administration"}</div><h1>{view === "teams" ? "Teams & users" : view === "policy" ? "AI governance" : activeProject?.name ?? "Create a project"}</h1></div><div className="topbarActions">{view === "builder" && activeProject && <StatusPill label={activeProject.status} tone="blue" />}{view === "builder" && policy && <StatusPill label={policy.provider.name} tone="green" />}<button className="iconButton" title="Refresh" onClick={() => view === "builder" ? void refreshProject() : setView(view)}><RefreshCw size={18} /></button></div></header>
      {error && <div className="errorBanner" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {view !== "builder" ? <GovernancePanel mode={view} session={session} projects={projects} onError={setError} /> : !activeProject ? <EmptyProject onCreate={() => setCreateOpen(true)} /> : <section className="mainGrid">
        <ChatPanel phase={phase} prompt={prompt} run={activeRun} canApprove={Boolean(activeRun?.status === "waiting_approval" && activeRun.userId !== session.user.userId && ["owner", "admin", "reviewer"].includes(session.user.role))} onPhaseChange={setPhase} onPromptChange={setPrompt} onStartRun={startRun} onApproveRun={approveRun} />
        <PreviewPanel project={activeProject} run={activeRun} viewport={viewport} onViewportChange={setViewport} />
        <RightPanel activeTab={tab} onChangeTab={setTab} run={activeRun} policy={policy} usage={usage} metricScopes={metricScopes} metricScopeKey={metricScopeKey} onMetricScopeChange={setMetricScopeKey} deployments={deployments} project={activeProject} currentUserId={session.user.userId} role={session.user.role} onDeploy={createDeployment} onApproveDeployment={approveDeployment} />
      </section>}
    </section>
  </main>;
}

function ChatPanel({ phase, prompt, run, canApprove, onPhaseChange, onPromptChange, onStartRun, onApproveRun }: { phase: AgentPhase; prompt: string; run?: Run; canApprove: boolean; onPhaseChange: (value: AgentPhase) => void; onPromptChange: (value: string) => void; onStartRun: () => void; onApproveRun: () => void }) {
  return <section className="panel chatPanel"><div className="panelHeader"><div className="panelTitle"><MessageSquare size={18} />Agent</div>{run && <StatusPill label={run.status} tone={run.status === "failed" ? "amber" : "blue"} />}</div>
    <div className="promptControls"><label className="fieldLabel" htmlFor="phase">Phase</label><label className="selectShell fullWidth"><select id="phase" value={phase} onChange={(event) => onPhaseChange(event.target.value as AgentPhase)}>{phases.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={16} /></label></div>
    <div className="messageStream">{run ? <><div className="message userMessage"><span className="avatar">YOU</span><p>{run.prompt}</p></div><div className="message agentMessage"><span className="agentAvatar"><Bot size={16} /></span><div><strong>Run timeline</strong><ul>{run.events.map((event) => <li key={event.sequence}>{event.message}</li>)}</ul></div></div></> : <div className="emptyRun"><Bot size={24} /><p>Describe the app or change you want to build.</p></div>}</div>
    <div className="composer"><textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={4} placeholder="Build an account dashboard with..." />{canApprove && <button className="primaryButton" onClick={onApproveRun}><ShieldCheck size={17} />Approve run</button>}<button className="primaryButton" onClick={onStartRun} disabled={!prompt.trim() || Boolean(run && !["ready", "failed"].includes(run.status))}><Play size={17} />Run agent</button></div>
  </section>;
}

function PreviewPanel({ project, run, viewport, onViewportChange }: { project: Project; run?: Run; viewport: ViewportMode; onViewportChange: (value: ViewportMode) => void }) {
  return <section className="panel previewPanel"><div className="panelHeader"><div className="panelTitle"><Monitor size={18} />Live Preview</div><div className="segmented"><ViewportButton value="desktop" active={viewport} set={onViewportChange} icon={<Monitor size={16} />} /><ViewportButton value="tablet" active={viewport} set={onViewportChange} icon={<Tablet size={16} />} /><ViewportButton value="mobile" active={viewport} set={onViewportChange} icon={<Smartphone size={16} />} /></div></div>
    <div className={`previewStage ${viewport}`}><div className="previewChrome"><div className="previewUrl"><Lock size={13} />{project.previewUrl}</div><div className="previewDots"><span /><span /><span /></div></div><iframe key={`${project.id}-${run?.id}-${run?.status}`} src={project.previewUrl} title={`${project.name} preview`} sandbox="allow-scripts allow-forms allow-modals" /></div>
    <footer className="previewFooter"><div><Activity size={16} />{run && !["ready", "failed"].includes(run.status) ? "Agent working" : "Preview ready"}</div><div><Terminal size={16} />{formatTokens(run?.totalTokens ?? 0)} tokens</div></footer>
  </section>;
}

function RightPanel({ activeTab, onChangeTab, run, policy, usage, metricScopes, metricScopeKey, onMetricScopeChange, deployments, project, currentUserId, role, onDeploy, onApproveDeployment }: { activeTab: RightPanelTab; onChangeTab: (tab: RightPanelTab) => void; run?: Run; policy: EffectiveAiPolicy | null; usage: UsageRow[]; metricScopes: MetricScope[]; metricScopeKey: string; onMetricScopeChange: (value: string) => void; deployments: Deployment[]; project: Project; currentUserId: string; role: Role; onDeploy: (environment: "staging" | "production") => Promise<void>; onApproveDeployment: (id: string) => Promise<void> }) {
  const totals = useMemo(() => usage.reduce((sum, item) => ({ tokens: sum.tokens + item.totalTokens, cost: sum.cost + item.estimatedCostUsd, requests: sum.requests + item.requests }), { tokens: 0, cost: 0, requests: 0 }), [usage]);
  return <section className="panel detailsPanel"><div className="tabbar"><TabButton icon={<FileCode2 size={16} />} label="Files" tab="files" active={activeTab} set={onChangeTab} /><TabButton icon={<Bot size={16} />} label="AI" tab="ai" active={activeTab} set={onChangeTab} /><TabButton icon={<Gauge size={16} />} label="Metrics" tab="metrics" active={activeTab} set={onChangeTab} /><TabButton icon={<Rocket size={16} />} label="Deploy" tab="deploy" active={activeTab} set={onChangeTab} /></div>
    {activeTab === "files" && <div className="tabContent"><div className="infoRow"><span>Run</span><strong><GitBranch size={14} />{run?.commitSha?.slice(0, 8) ?? run?.id.slice(0, 8) ?? "No run"}</strong></div><div className="fileList">{run?.files.length ? run.files.map((file) => <article className="fileItem" key={file.path}><div><strong>{file.path}</strong><p>{file.summary}</p></div><span>+{file.additions} -{file.deletions}</span></article>) : <p className="mutedText">Changed files appear after a run completes.</p>}</div></div>}
    {activeTab === "ai" && <div className="tabContent">{policy ? <><MetricTile icon={<Bot size={18} />} label="Provider" value={policy.provider.name} detail={policy.provider.baseUrl} /><MetricTile icon={<Code2 size={18} />} label="Model" value={policy.model} detail={`${policy.allowedModels.length} allowed model(s)`} /><MetricTile icon={<ShieldCheck size={18} />} label="Monthly boundary" value={formatTokens(policy.monthlyTokenLimit)} detail={`$${policy.monthlyCostLimitUsd.toLocaleString()} cost cap`} /><div className="hookList"><div className="sectionTitle">Applied hooks</div>{policy.hooks.map((hook) => <article className="hookItem" key={hook.id}><strong>{hook.title}</strong><p>{hook.prompt}</p></article>)}</div></> : <p className="mutedText">No effective policy.</p>}</div>}
    {activeTab === "metrics" && <div className="tabContent"><label className="selectShell fullWidth"><select aria-label="Usage scope" value={metricScopeKey} onChange={(event) => onMetricScopeChange(event.target.value)}>{metricScopes.map((scope) => <option key={`${scope.scope}:${scope.id}`} value={`${scope.scope}:${scope.id}`}>{scope.scope}: {scope.label}</option>)}</select><ChevronDown size={16} /></label><MetricTile icon={<CircleDollarSign size={18} />} label="Usage" value={formatTokens(totals.tokens)} detail={`$${totals.cost.toFixed(2)} across ${totals.requests} requests`} /><UsageBars values={usage} /></div>}
    {activeTab === "deploy" && <div className="tabContent"><MetricTile icon={<Cloud size={18} />} label="Environment" value={project.environment} detail="Approval-gated deployment record" /><div className="checkList">{deployments.map((deployment) => <div className="checkItem" key={deployment.id}><span className={`checkIcon ${deployment.status === "approved" ? "passed" : "pending"}`}>{deployment.status === "approved" && <Check size={14} />}</span><div><strong>{deployment.environment}</strong><small>{deployment.status}</small></div>{deployment.status === "waiting_approval" && deployment.requestedBy !== currentUserId && ["owner", "admin", "reviewer"].includes(role) && <button className="miniIcon" title="Approve deployment" onClick={() => void onApproveDeployment(deployment.id)}><ShieldCheck size={15} /></button>}</div>)}</div><button className="primaryButton" onClick={() => void onDeploy("staging")}><Rocket size={16} />Create staging record</button><button className="secondaryButton" onClick={() => void onDeploy("production")}><ShieldCheck size={16} />Request production</button></div>}
  </section>;
}

interface ProviderSetting { id: string; name: string; baseUrl: string; defaultModel: string; allowedModels: string[]; hasApiKey: boolean; enabled: boolean }
interface TeamSetting { id: string; name: string; slug: string; memberCount: number }
interface UserSetting { id: string; name: string; email: string; role: Role; teams: Array<{ id: string; name: string; role: Role }> }
interface PolicySetting { id: string; scope_type: string; scope_id: string; default_model: string; monthly_token_limit: string; monthly_cost_limit_usd: string }
interface HookSetting { id: string; scope_type: string; phase: string; title: string; priority: number }

function GovernancePanel({ mode, session, projects, onError }: { mode: "teams" | "policy"; session: Session; projects: Project[]; onError: (value: string) => void }) {
  const [providers, setProviders] = useState<ProviderSetting[]>([]);
  const [teams, setTeams] = useState<TeamSetting[]>([]);
  const [users, setUsers] = useState<UserSetting[]>([]);
  const [policies, setPolicies] = useState<PolicySetting[]>([]);
  const [hooks, setHooks] = useState<HookSetting[]>([]);
  const [scope, setScope] = useState<"global" | "team" | "user" | "project">("global");
  const [hookScope, setHookScope] = useState<"global" | "team">("global");
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

  async function submit(path: string, event: FormEvent<HTMLFormElement>, transform: (data: FormData) => unknown = Object.fromEntries) {
    event.preventDefault(); onError(""); const form = event.currentTarget;
    try { await api(path, { method: "POST", body: JSON.stringify(transform(new FormData(form))) }); form.reset(); setRevision((value) => value + 1); }
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
      <div className="settingsTable">{providers.map((provider) => <div className="settingsRow" key={provider.id}><span className="settingIcon"><Bot size={17} /></span><div><strong>{provider.name}</strong><small>{provider.baseUrl}</small></div><span>{provider.defaultModel}</span></div>)}</div>
      <form className="settingsForm" onSubmit={(event) => void submit("/api/admin/providers", event, (data) => ({ name: data.get("name"), baseUrl: data.get("baseUrl"), apiKey: data.get("apiKey") || undefined, defaultModel: data.get("defaultModel"), allowedModels: String(data.get("allowedModels")).split(",").map((value) => value.trim()).filter(Boolean), inputCostPerMillion: Number(data.get("inputCostPerMillion")), outputCostPerMillion: Number(data.get("outputCostPerMillion")) }))}><label>Name<input name="name" required /></label><label>Endpoint<input name="baseUrl" type="url" placeholder="https://.../v1" required /></label><label>API key<input name="apiKey" type="password" /></label><label>Default model<input name="defaultModel" required /></label><label>Allowed models<input name="allowedModels" placeholder="model-a, model-b" required /></label><label>Input $ / 1M<input name="inputCostPerMillion" type="number" min="0" step="0.000001" defaultValue="0" required /></label><label>Output $ / 1M<input name="outputCostPerMillion" type="number" min="0" step="0.000001" defaultValue="0" required /></label><button className="primaryButton"><Plus size={16} />Add provider</button></form>
    </section>
    <section className="settingsSection"><div className="settingsHeading"><div><h2>Scoped policies</h2><p>Global boundaries are intersected with team, user, and project choices.</p></div></div>
      <div className="settingsTable">{policies.map((item) => <div className="settingsRow" key={item.id}><span className="settingIcon"><ShieldCheck size={17} /></span><div><strong>{item.scope_type}</strong><small>{item.default_model}</small></div><span>{formatTokens(Number(item.monthly_token_limit))} / ${item.monthly_cost_limit_usd}</span></div>)}</div>
      <form className="settingsForm" onSubmit={(event) => void submit("/api/admin/policies", event, (data) => { const providerId = String(data.get("defaultProviderId")); const model = String(data.get("defaultModel")); return { scopeType: data.get("scopeType"), scopeId: data.get("scopeId"), defaultProviderId: providerId, defaultModel: model, allowedProviderIds: [providerId], allowedModels: String(data.get("allowedModels")).split(",").map((value) => value.trim()).filter(Boolean), monthlyTokenLimit: Number(data.get("monthlyTokenLimit")), monthlyCostLimitUsd: Number(data.get("monthlyCostLimitUsd")), allowUserOverride: data.get("allowUserOverride") === "on", requireApprovalFor: data.getAll("requireApprovalFor") }; })}><label>Scope<select name="scopeType" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="global">Global</option><option value="team">Team</option>{session.user.role === "owner" && <option value="user">User</option>}<option value="project">Project</option></select></label><label>Target<select name="scopeId">{scopeTargets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label><label>Provider<select name="defaultProviderId">{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label><label>Default model<input name="defaultModel" required /></label><label>Allowed models<input name="allowedModels" placeholder="model-a, model-b" required /></label><label>Monthly tokens<input name="monthlyTokenLimit" type="number" min="1" defaultValue="1000000" required /></label><label>Monthly cost USD<input name="monthlyCostLimitUsd" type="number" min="0" step="0.01" defaultValue="100" required /></label><label className="checkboxLabel"><input name="allowUserOverride" type="checkbox" />Allow user defaults</label><fieldset className="wideField"><legend>Approval required</legend>{phases.map((item) => <label className="checkboxLabel" key={item}><input name="requireApprovalFor" type="checkbox" value={item} defaultChecked={["database_migration", "production_deploy_prepare"].includes(item)} />{item}</label>)}</fieldset><button className="primaryButton"><ShieldCheck size={16} />Save policy</button></form>
    </section>
    <section className="settingsSection"><div className="settingsHeading"><div><h2>Prompt hooks</h2><p>Inject company and stack rules at specific agent lifecycle phases.</p></div></div>
      <div className="settingsTable">{hooks.map((hook) => <div className="settingsRow" key={hook.id}><span className="settingIcon"><Code2 size={17} /></span><div><strong>{hook.title}</strong><small>{hook.scope_type} · {hook.phase}</small></div><span>Priority {hook.priority}</span></div>)}</div>
      <form className="settingsForm" onSubmit={(event) => void submit("/api/admin/hooks", event, (data) => ({ scopeType: data.get("scopeType"), scopeId: data.get("scopeId"), phase: data.get("phase"), priority: Number(data.get("priority")), mandatory: data.get("mandatory") === "on", title: data.get("title"), prompt: data.get("prompt") }))}><label>Scope<select name="scopeType" value={hookScope} onChange={(event) => setHookScope(event.target.value as typeof hookScope)}><option value="global">Global</option>{session.teams[0] && <option value="team">Team</option>}</select></label><label>Target<select name="scopeId">{hookScope === "global" ? <option value={session.user.organizationId}>{session.user.organizationName}</option> : session.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><label>Phase<select name="phase">{phases.map((item) => <option key={item}>{item}</option>)}</select></label><label>Title<input name="title" required /></label><label>Priority<input name="priority" type="number" defaultValue="0" required /></label><label className="wideField">Prompt<textarea name="prompt" rows={3} required /></label><label className="checkboxLabel"><input name="mandatory" type="checkbox" />Mandatory</label><button className="primaryButton"><Plus size={16} />Add hook</button></form>
    </section>
  </section>;
}

function ServiceUnavailable({ message, retry }: { message: string; retry: () => Promise<void> }) {
  return <main className="authShell"><section className="authPanel serviceState"><span className="brandMark"><Terminal size={20} /></span><h1>Service unavailable</h1><p>{message}</p><button className="primaryButton" onClick={() => void retry()}><RefreshCw size={17} />Retry</button></section></main>;
}

function ViewportButton({ value, active, set, icon }: { value: ViewportMode; active: ViewportMode; set: (value: ViewportMode) => void; icon: ReactNode }) { return <button className={active === value ? "active" : ""} onClick={() => set(value)} title={`${value} viewport`}>{icon}</button>; }
function TabButton({ icon, label, tab, active, set }: { icon: ReactNode; label: string; tab: RightPanelTab; active: RightPanelTab; set: (value: RightPanelTab) => void }) { return <button className={active === tab ? "active" : ""} onClick={() => set(tab)}>{icon}{label}</button>; }
function StatusPill({ label, tone }: { label: string; tone: "blue" | "green" | "amber" }) { return <span className={`statusPill ${tone}`}>{label}</span>; }
function MetricTile({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) { return <article className="metricTile"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>; }
function UsageBars({ values }: { values: UsageRow[] }) { const grouped = Object.values(values.reduce<Record<string, { model: string; tokens: number }>>((all, row) => { const item = all[row.model] ?? { model: row.model, tokens: 0 }; item.tokens += row.totalTokens; all[row.model] = item; return all; }, {})); const max = Math.max(...grouped.map((item) => item.tokens), 1); return <section className="usageGroup"><div className="sectionTitle">Models</div>{grouped.map((item) => <div className="usageBar" key={item.model}><div><strong>{item.model}</strong><span>{formatTokens(item.tokens)}</span></div><progress value={item.tokens} max={max} /></div>)}</section>; }
function EmptyProject({ onCreate }: { onCreate: () => void }) { return <section className="emptyProject"><Boxes size={32} /><h2>No projects yet</h2><button className="primaryButton" onClick={onCreate}><Plus size={17} />Create project</button></section>; }
function formatTokens(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value); }
function showError(set: (value: string) => void) { return (error: unknown) => set(error instanceof Error ? error.message : "Request failed"); }
