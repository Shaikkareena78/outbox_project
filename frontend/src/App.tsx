import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Clock3,
  FileUp,
  Inbox,
  LoaderCircle,
  LogOut,
  Mail,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Slack,
  Trash2,
  Users
} from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "1" || new URLSearchParams(window.location.search).get("demo") === "1";

interface User {
  id: string;
  name: string;
  email: string;
  picture: string | null;
  slackConnected: boolean;
  slackTeam: string | null;
}

interface EmailRecord {
  id: string;
  recipient: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: "scheduled" | "sending" | "sent" | "failed";
  error?: string | null;
}

interface ScheduleResponse {
  campaignId: string;
  scheduled: number;
}

const demoUser: User = {
  id: "demo-user",
  name: "Olivia Chen",
  email: "olivia.chen@example.com",
  picture: null,
  slackConnected: false,
  slackTeam: null
};

function demoDate(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const demoEmails: EmailRecord[] = [
  {
    id: "demo-scheduled-1",
    recipient: "maya.patel@example.com",
    subject: "A quick idea for your growth team",
    scheduledAt: demoDate(0.5),
    sentAt: null,
    status: "scheduled"
  },
  {
    id: "demo-scheduled-2",
    recipient: "james.wilson@example.com",
    subject: "Loved your recent product launch",
    scheduledAt: demoDate(1),
    sentAt: null,
    status: "scheduled"
  },
  {
    id: "demo-scheduled-3",
    recipient: "amira.hassan@example.com",
    subject: "Partnership opportunity for Acme",
    scheduledAt: demoDate(2),
    sentAt: null,
    status: "scheduled"
  },
  {
    id: "demo-sent-1",
    recipient: "noah.kim@example.com",
    subject: "Scaling outbound without the busywork",
    scheduledAt: demoDate(-5),
    sentAt: demoDate(-4.9),
    status: "sent"
  },
  {
    id: "demo-sent-2",
    recipient: "sophia.martin@example.com",
    subject: "A workflow idea for Northstar",
    scheduledAt: demoDate(-25),
    sentAt: demoDate(-24.9),
    status: "sent"
  },
  {
    id: "demo-failed-1",
    recipient: "ethan.brooks@example.com",
    subject: "Following up on our conversation",
    scheduledAt: demoDate(-12),
    sentAt: null,
    status: "failed",
    error: "Demo: temporary SMTP delivery failure"
  }
];

let demoEmailStore: EmailRecord[] | null = null;
let demoSlackConnected = false;

function getDemoEmails(): EmailRecord[] {
  if (!demoEmailStore) {
    try {
      const saved = window.localStorage.getItem("reachinbox-demo-emails");
      demoEmailStore = saved ? JSON.parse(saved) as EmailRecord[] : demoEmails;
    } catch {
      demoEmailStore = demoEmails;
    }
  }
  return demoEmailStore;
}

function saveDemoEmails(emails: EmailRecord[]): void {
  demoEmailStore = emails;
  window.localStorage.setItem("reachinbox-demo-emails", JSON.stringify(emails));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (DEMO_MODE) {
    const method = init?.method ?? "GET";
    if (path === "/api/me") {
      return { ...demoUser, slackConnected: demoSlackConnected, slackTeam: demoSlackConnected ? "ReachInbox Demo" : null } as T;
    }
    if (path.startsWith("/api/emails?status=")) {
      const status = new URLSearchParams(path.split("?")[1]).get("status");
      const emails = getDemoEmails();
      const rows = status === "scheduled"
        ? emails.filter((email) => email.status === "scheduled" || email.status === "sending")
        : status === "sent"
          ? emails.filter((email) => email.status === "sent")
          : emails.filter((email) => email.status === "failed");
      return rows as T;
    }
    if (path === "/api/senders") {
      return { senders: ["olivia@ethereal.email", "team@ethereal.email"] } as T;
    }
    if (path.startsWith("/api/emails/search")) {
      const query = new URLSearchParams(path.split("?")[1]).get("q")?.toLowerCase() ?? "";
      return getDemoEmails().filter((email) =>
        `${email.recipient} ${email.subject}`.toLowerCase().includes(query)
      ) as T;
    }
    if (path === "/api/emails/schedule" && method === "POST") {
      const input = JSON.parse(String(init?.body)) as {
        subject: string;
        recipients: string[];
        startAt: string;
        delayMs: number;
      };
      const id = crypto.randomUUID();
      const newEmails = input.recipients.map((recipient, index): EmailRecord => ({
        id: `${id}-${index}`,
        recipient,
        subject: input.subject,
        scheduledAt: new Date(new Date(input.startAt).getTime() + index * input.delayMs).toISOString(),
        sentAt: null,
        status: "scheduled"
      }));
      saveDemoEmails([...newEmails, ...getDemoEmails()]);
      return { campaignId: id, scheduled: newEmails.length } as T;
    }
    if (path === "/auth/logout" && method === "POST") return undefined as T;
    if (path === "/api/slack" && method === "DELETE") {
      demoSlackConnected = false;
      return undefined as T;
    }
  }
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string };
      message = body.error ?? message;
    } catch {
      // Use the HTTP status when the server does not return JSON.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function localDateTime(minutesFromNow: number): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [senders, setSenders] = useState<string[]>([]);
  const [tab, setTab] = useState<"scheduled" | "sent">("scheduled");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<EmailRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [scheduled, sent, failed] = await Promise.all([
        request<EmailRecord[]>("/api/emails?status=scheduled"),
        request<EmailRecord[]>("/api/emails?status=sent"),
        request<EmailRecord[]>("/api/emails?status=failed")
      ]);
      setEmails([...scheduled, ...sent, ...failed]);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not load emails" });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    request<User>("/api/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    void Promise.all([
      refresh(),
      request<{ senders: string[] }>("/api/senders").then((result) => setSenders(result.senders))
    ]).catch((error: unknown) => {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not load account data" });
    });
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [user, refresh, refreshKey]);

  const counts = useMemo(() => ({
    scheduled: emails.filter((email) => email.status === "scheduled" || email.status === "sending").length,
    sent: emails.filter((email) => email.status === "sent").length,
    failed: emails.filter((email) => email.status === "failed").length
  }), [emails]);

  const visibleEmails = useMemo(() => {
    if (searchResults) return searchResults;
    return emails.filter((email) => tab === "scheduled"
      ? email.status === "scheduled" || email.status === "sending"
      : email.status === "sent" || email.status === "failed");
  }, [emails, searchResults, tab]);

  async function searchEmails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = search.trim();
    if (!query) {
      setSearchResults(null);
      return;
    }
    try {
      const results = await request<EmailRecord[]>(`/api/emails/search?q=${encodeURIComponent(query)}`);
      setSearchResults(results);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Search failed" });
    }
  }

  async function logout() {
    await request<void>("/auth/logout", { method: "POST" });
    setUser(null);
    setEmails([]);
  }

  async function disconnectSlack() {
    try {
      await request<void>("/api/slack", { method: "DELETE" });
      setUser((previous) => previous ? { ...previous, slackConnected: false, slackTeam: null } : previous);
      setNotice({ kind: "success", text: "Slack disconnected." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not disconnect Slack" });
    }
  }

  function connectSlack() {
    if (DEMO_MODE) {
      setUser((previous) => previous ? { ...previous, slackConnected: true, slackTeam: "ReachInbox Demo" } : previous);
      setNotice({ kind: "success", text: "Demo Slack connection enabled." });
      return;
    }
    window.location.assign(`${API_URL}/auth/slack`);
  }

  if (authLoading) {
    return <div className="full-screen"><LoaderCircle className="spin" size={28} /><span>Loading your workspace…</span></div>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-card">
          <div className="brand-mark"><Send size={20} /></div>
          <p className="eyebrow">REACHINBOX WORKSPACE</p>
          <h1>Outreach, on schedule.</h1>
          <p className="muted">Sign in to schedule, monitor, and search your email campaigns.</p>
          <a className="button primary wide" href={`${API_URL}/auth/google`}>
            <GoogleMark /> Continue with Google <ArrowUpRight size={16} />
          </a>
          <p className="login-note"><ShieldCheck size={15} /> Secure Google OAuth sign-in</p>
        </div>
        <div className="login-footer">A smarter way to build meaningful connections.</div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="ReachInbox home">
          <span className="brand-mark"><Send size={18} /></span>
          <span>reachinbox<span className="brand-dot">.</span></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <button className={`side-link ${tab === "scheduled" && !searchResults ? "active" : ""}`} onClick={() => { setTab("scheduled"); setSearchResults(null); }}>
          <Clock3 size={17} /> Scheduled <span className="side-count">{counts.scheduled}</span>
        </button>
        <button className={`side-link ${tab === "sent" && !searchResults ? "active" : ""}`} onClick={() => { setTab("sent"); setSearchResults(null); }}>
          <Inbox size={17} /> Sent emails <span className="side-count">{counts.sent}</span>
        </button>
        <div className="sidebar-bottom">
          <div className="sender-card">
            <span className="sender-icon"><Mail size={16} /></span>
            <div><strong>{senders.length ? `${senders.length} sender${senders.length === 1 ? "" : "s"}` : "Sender not set"}</strong><small>SMTP accounts</small></div>
            <Settings2 size={16} className="sender-settings" />
          </div>
          <div className="user-mini">
            {user.picture ? <img src={user.picture} alt="" /> : <span className="avatar-fallback">{user.name[0]}</span>}
            <div className="user-copy"><strong>{user.name}</strong><small>{user.email}</small></div>
            <button className="icon-button" title="Log out" onClick={() => void logout()}><LogOut size={17} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Campaigns</span><span className="crumb-slash">/</span><strong>{searchResults ? "Search results" : tab === "scheduled" ? "Scheduled emails" : "Sent emails"}</strong></div>
          <div className="top-actions">
            {DEMO_MODE && <span className="demo-label">DEMO DATA</span>}
            <button className={`slack-button ${user.slackConnected ? "connected" : ""}`} onClick={() => user.slackConnected ? void disconnectSlack() : connectSlack()}>
              {user.slackConnected ? <Check size={16} /> : <Slack size={16} />}
              {user.slackConnected ? `Slack · ${user.slackTeam ?? "Connected"}` : "Connect Slack"}
            </button>
            <div className="header-user">
              {user.picture ? <img src={user.picture} alt="" /> : <span className="avatar-fallback">{user.name[0]}</span>}
              <div><strong>{user.name}</strong><small>{user.email}</small></div>
            </div>
          </div>
        </header>

        <section className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">EMAIL CAMPAIGNS</p>
              <h1>{searchResults ? "Search results" : tab === "scheduled" ? "Scheduled emails" : "Sent emails"}</h1>
              <p className="muted">{searchResults ? `Matching “${search}”` : tab === "scheduled" ? "A clear view of what’s queued and when it will go out." : "Track delivery across every recipient in your campaigns."}</p>
            </div>
            <button className="button primary" onClick={() => setComposeOpen(true)}><Plus size={18} /> Compose new email</button>
          </div>

          <div className="stats-row">
            <StatCard label="Scheduled" value={counts.scheduled} icon={<Clock3 size={17} />} tone="purple" />
            <StatCard label="Sent" value={counts.sent} icon={<Check size={17} />} tone="green" />
            <StatCard label="Failed" value={counts.failed} icon={<AlertCircle size={17} />} tone="red" />
          </div>

          <div className="table-card">
            <div className="table-toolbar">
              <div className="table-tabs">
                <button className={tab === "scheduled" && !searchResults ? "selected" : ""} onClick={() => { setTab("scheduled"); setSearchResults(null); }}>Scheduled <span>{counts.scheduled}</span></button>
                <button className={tab === "sent" && !searchResults ? "selected" : ""} onClick={() => { setTab("sent"); setSearchResults(null); }}>Sent <span>{counts.sent + counts.failed}</span></button>
              </div>
              <form className="search-box" onSubmit={(event) => void searchEmails(event)}>
                <Search size={16} />
                <input aria-label="Search emails" placeholder="Search emails…" value={search} onChange={(event) => setSearch(event.target.value)} />
                {searchResults && <button type="button" className="clear-search" onClick={() => { setSearch(""); setSearchResults(null); }}>Clear</button>}
              </form>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>RECIPIENT</th><th>SUBJECT</th><th>{tab === "scheduled" && !searchResults ? "SCHEDULED FOR" : "SENT AT"}</th><th>STATUS</th></tr></thead>
                <tbody>
                  {loading && !emails.length ? (
                    <tr><td colSpan={4}><div className="table-message"><LoaderCircle className="spin" size={20} /> Loading emails…</div></td></tr>
                  ) : visibleEmails.length === 0 ? (
                    <tr><td colSpan={4}><EmptyState tab={tab} searching={Boolean(searchResults)} onCompose={() => setComposeOpen(true)} /></td></tr>
                  ) : visibleEmails.map((email) => (
                    <tr key={email.id}>
                      <td><span className="recipient-avatar">{email.recipient[0]?.toUpperCase()}</span><strong>{email.recipient}</strong></td>
                      <td className="subject-cell">{email.subject}</td>
                      <td className="date-cell">{formatDate(email.status === "sent" ? email.sentAt : email.scheduledAt)}</td>
                      <td><StatusBadge status={email.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>Showing {visibleEmails.length} email{visibleEmails.length === 1 ? "" : "s"}</span><button className="refresh-link" onClick={() => setRefreshKey((key) => key + 1)}>Refresh data</button></div>
          </div>
          <p className="auto-refresh"><span className="live-dot" /> Queue status refreshes automatically every 10 seconds</p>
        </section>
      </main>

      {notice && <div className={`toast ${notice.kind}`} role="status"><span>{notice.kind === "success" ? <Check size={17} /> : <AlertCircle size={17} />}{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
      {composeOpen && (
        <ComposeModal
          senders={senders}
          onClose={() => setComposeOpen(false)}
          onScheduled={(result) => {
            setComposeOpen(false);
            setTab("scheduled");
            setSearchResults(null);
            setNotice({ kind: "success", text: `${result.scheduled} email${result.scheduled === 1 ? "" : "s"} added to the schedule.` });
            setRefreshKey((key) => key + 1);
          }}
          onError={(message) => setNotice({ kind: "error", text: message })}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) {
  return <div className="stat-card"><span className={`stat-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value.toLocaleString()}</strong></div><span className="stat-caption">All time</span></div>;
}

function StatusBadge({ status }: { status: EmailRecord["status"] }) {
  const label = status === "sending" ? "Sending" : status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`status-badge ${status}`}><i />{label}</span>;
}

function EmptyState({ tab, searching, onCompose }: { tab: "scheduled" | "sent"; searching: boolean; onCompose: () => void }) {
  return <div className="empty-state"><span className="empty-icon">{searching ? <Search size={22} /> : tab === "scheduled" ? <Clock3 size={22} /> : <Send size={22} />}</span><strong>{searching ? "No matching emails" : tab === "scheduled" ? "Nothing scheduled yet" : "No sent emails yet"}</strong><p>{searching ? "Try another search term." : tab === "scheduled" ? "Compose your first email campaign to see it here." : "Emails will appear here after they have been sent."}</p>{!searching && tab === "scheduled" && <button className="button secondary small" onClick={onCompose}><Plus size={15} /> Compose email</button>}</div>;
}

function ComposeModal({
  senders,
  onClose,
  onScheduled,
  onError
}: {
  senders: string[];
  onClose: () => void;
  onScheduled: (result: ScheduleResponse) => void;
  onError: (message: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sender, setSender] = useState(senders[0] ?? "");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [startAt, setStartAt] = useState(localDateTime(5));
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(200);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());

  async function readLeads(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
      const unique = [...new Set(matches.map((email) => email.toLowerCase()))];
      setRecipients(unique);
      setFormError(unique.length ? "" : "No email addresses found in this file.");
    } catch {
      setFormError("Could not read the selected file.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!recipients.length) {
      setFormError("Upload a CSV or text file containing at least one email address.");
      return;
    }
    if (new Date(startAt).getTime() <= Date.now()) {
      setFormError("Choose a start time in the future.");
      return;
    }
    setBusy(true);
    try {
      const result = await request<ScheduleResponse>("/api/emails/schedule", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({
          subject,
          body,
          sender: sender || undefined,
          recipients,
          startAt: new Date(startAt).toISOString(),
          delayMs: Math.round(delaySeconds * 1000),
          hourlyLimit
        })
      });
      onScheduled(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not schedule emails";
      setFormError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title">
        <header className="modal-header"><div><p className="eyebrow">NEW CAMPAIGN</p><h2 id="compose-title">Compose email</h2></div><button className="icon-button close-button" onClick={onClose} aria-label="Close">×</button></header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <label className="field full"><span>Subject</span><input required maxLength={500} placeholder="A thoughtful subject line" value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
            <label className="field full"><span>Email body</span><textarea required rows={5} placeholder="Write your email…" value={body} onChange={(event) => setBody(event.target.value)} /></label>
            <div className="field full">
              <span>Recipients <span className="field-hint">CSV or plain text</span></span>
              <label className="upload-area">
                <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void readLeads(event)} />
                <FileUp size={19} /><span><strong>{fileName || "Choose a leads file"}</strong><small>{recipients.length ? `${recipients.length} unique email address${recipients.length === 1 ? "" : "es"} detected` : "We’ll extract and deduplicate email addresses."}</small></span>
                {recipients.length > 0 && <span className="detected-count"><Users size={14} /> {recipients.length}</span>}
              </label>
              {recipients.length > 0 && <div className="recipient-preview">Preview: {recipients.slice(0, 3).join(", ")}{recipients.length > 3 ? `, +${recipients.length - 3} more` : ""}<button type="button" onClick={() => { setRecipients([]); setFileName(""); }} title="Remove leads"><Trash2 size={13} /></button></div>}
            </div>
            <label className="field"><span>Sender</span><select required value={sender} onChange={(event) => setSender(event.target.value)}>{senders.length ? senders.map((address) => <option key={address} value={address}>{address}</option>) : <option value="">Configure SMTP sender in backend</option>}</select></label>
            <label className="field"><span>Start time</span><input required type="datetime-local" value={startAt} min={localDateTime(1)} onChange={(event) => setStartAt(event.target.value)} /></label>
            <label className="field"><span>Delay between emails</span><div className="input-suffix"><input required type="number" min={0} max={86400} value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /><span>seconds</span></div></label>
            <label className="field"><span>Hourly sending limit</span><div className="input-suffix"><input required type="number" min={1} max={5000} value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} /><span>emails</span></div></label>
          </div>
          {formError && <p className="form-error"><AlertCircle size={15} />{formError}</p>}
          <div className="modal-footer"><span><ShieldCheck size={15} /> You can monitor this campaign in real time.</span><div><button className="button secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy || !senders.length}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{busy ? " Scheduling…" : `Schedule ${recipients.length || ""} email${recipients.length === 1 ? "" : "s"}`}</button></div></div>
        </form>
      </section>
    </div>
  );
}

function GoogleMark() {
  return <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" /><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.73 7.18l7.63 5.92c4.45-4.11 7.14-10.17 7.14-17.57z" /><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19z" /><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.78l-7.63-5.92c-2.12 1.42-4.85 2.27-8.28 2.27-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" /></svg>;
}

export default App;
