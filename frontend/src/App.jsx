import React, { useState, useRef, useEffect } from "react";

const API_URL = "http://127.0.0.1:8000/api/query";

export default function ChatFrontend() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);
  const [copiedLink, setCopiedLink] = useState(null);

  /* ---------------------- helpers ---------------------- */

  function extractLinksFromRaw(raw) {
    if (!raw) return [];
    const links = [];

    const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
    let m;
    while ((m = mdRegex.exec(raw)) !== null) {
      try {
        const url = m[2];
        if (!links.includes(url)) links.push(url);
      } catch (e) {
        console.error("Error extracting markdown link:", e);
      }
    }

    const urlRegex = /https?:\/\/[^\s)]+/gi;
    while ((m = urlRegex.exec(raw)) !== null) {
      const url = m[0];
      if (!links.includes(url)) links.push(url);
    }

    if (links.length === 0 && raw) {
      const words = raw.split(/\s+/);
      for (const w of words) {
        if (w.toLowerCase().startsWith("http")) {
          const clean = w.replace(/[",.;:]*$/, "");
          if (!links.includes(clean)) links.push(clean);
        }
      }
    }

    return links;
  }
  function cleanAndUniqueLinks(rawLinks) {
  if (!rawLinks?.length) return [];

  const unique = new Map();

  rawLinks.forEach((url) => {
    // Extract the base link (remove ? and after)
    const base = url.split("?")[0];

    // Only save first occurrence
    if (!unique.has(base)) {
      unique.set(base, url);
    }
  });

  return Array.from(unique.values());
}


  // Normalize and sanitize links:
  // - trim trailing punctuation
  // - ensure protocol
  // - ensure download= has a value (add download=source.pdf if empty)
  // - return normalized absolute href
  function normalizeLink(raw) {
    if (!raw) return raw;
    // trim whitespace and trailing punctuation characters
    let s = String(raw).trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
    // remove enclosing <...> if present
    if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);

    // remove trailing punctuation often included accidentally
    s = s.replace(/[\u2014\u2013]+$/, ""); // em/en dash
    s = s.replace(/[),.?!;:]+$/g, "");

    // if missing scheme, try adding http:
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
      s = "https://" + s;
    }

    try {
      const u = new URL(s);

      // handle download= with empty value (e.g., ?download= or &download=)
      if (u.searchParams.has("download")) {
        const val = u.searchParams.get("download");
        if (val === "" || val == null) {
          u.searchParams.set("download", "source.pdf");
        }
      } else {
        // handle weird cases where string literally ends with 'download='
        if (/download=$/.test(s)) {
          u.searchParams.set("download", "source.pdf");
        }
      }

      // if path ends with 'download' with no file, append '/source.pdf'
      if (u.pathname && /\/download\/?$/.test(u.pathname)) {
        if (!u.pathname.endsWith("/")) {
          u.pathname = u.pathname + "/";
        }
        u.pathname = u.pathname + "source.pdf";
      }

      // final normalized href
      return u.href;
    } catch (err) {
      // last-resort cleanup: trim and return original-ish trimmed
      const cleaned = s.replace(/[",]+$/g, "");
      return cleaned;
    }
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const path = u.pathname === "/" ? "" : u.pathname;
      const truncatedPath = path.length > 28 ? path.slice(0, 20) + "…" + path.slice(-6) : path;
      const queryHint = u.search ? " [q]" : "";
      return `${host}${truncatedPath}${queryHint}`;
    } catch (e) {
      return url.length > 40 ? url.slice(0, 36) + "…" : url;
    }
  }

  function domainInitials(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const parts = host.split(".");
      const meaningful = parts
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() || "")
        .join("");
      return meaningful || host.slice(0, 2).toUpperCase();
    } catch {
      return "LN";
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(text);
      setTimeout(() => setCopiedLink(null), 1400);
      console.log("Copied:", text);
    } catch (e) {
      console.error("Copy failed", e);
    }
  }

  /* ---------------------- networking / submission ---------------------- */

  async function submit(text) {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const userId = Date.now() + "_u";
    const userMsg = {
      id: userId,
      role: "user",
      text: trimmed,
      links: [],
      ts: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        console.log(txt);
        console.error("Backend HTTP error", resp.status, txt);
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + "_err",
            role: "bot",
            text: "An internal error occurred. Please try again later.",
            links: [],
            ts: new Date().toISOString(),
          },
        ]);
        setLoading(false);
        return;
      }

      const contentType = resp.headers.get("content-type") || "";
      let rawAnswer = "";
      if (contentType.includes("application/json")) {
        const j = await resp.json();
        rawAnswer = j.answer || j.output || j.text || (typeof j === "string" ? j : JSON.stringify(j));
      } else {
        rawAnswer = await resp.text();
      }

      if (rawAnswer && rawAnswer.trim().startsWith("[ERROR]")) {
        console.error("Server error:", rawAnswer);
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + "_e",
            role: "bot",
            text: "An internal error occurred. Please try again later.",
            links: [],
            ts: new Date().toISOString(),
          },
        ]);
        setLoading(false);
        return;
      }

      rawAnswer = stripFilenamesBeforeLinks(rawAnswer);
      const visible = stripSourcesBlock(rawAnswer);

      // normalize all extracted links, dedupe, preserve order
      const rawLinks = extractLinksFromRaw(rawAnswer);
      const cleanLinks= cleanAndUniqueLinks(rawLinks);
      const normalized = [];
      const seen = new Set();
      for (const rl of cleanLinks) {
        const n = normalizeLink(rl);
        if (!seen.has(n)) {
          seen.add(n);
          normalized.push(n);
        }
      }

      setMessages((m) => [
        ...m,
        {
          id: Date.now() + "_b",
          role: "bot",
          text: visible || (normalized.length ? "" : "No content."),
          links: normalized,
          showSources: false,
          ts: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      console.error("Fetch / parsing error:", err);
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + "_err2",
          role: "bot",
          text: "An internal error occurred. Please try again later.",
          links: [],
          ts: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function sendQuery(e) {
    e && e.preventDefault();
    if (!query.trim()) return;
    const text = query;
    setQuery("");
    await submit(text);
  }

  function toggleSources(id) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, showSources: !m.showSources } : m)));
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    });
  }

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, loading]);

  /* small helper used by rendering to toggle by message object */
  function toggleSourcesForMessage(m) {
    toggleSources(m.id);
  }

  /* ---------------------- render ---------------------- */

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.headerRow}>
          <div style={styles.header}>IMS CHATBOT</div>
          <div style={styles.headerRight}>
            <button style={styles.smallBtn} title="Clear chat" onClick={() => setMessages([])}>
              Clear
            </button>
          </div>
        </header>

        <div ref={containerRef} style={styles.chatArea}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={m.role === "user" ? styles.userBubble : styles.botBubble}
              aria-live={m.role === "bot" ? "polite" : undefined}
            >
              <div style={styles.messageTextBlock}>
                <div style={styles.messageTextInner}>
                  {m.text &&
                    m.text.split("\n").map((line, i) => (
                      <p key={i} style={{ margin: "6px 0" }}>
                        {line}
                      </p>
                    ))}
                </div>

                {/* Timestamp - time only */}
                <div style={styles.timestampRow}>
                  <span style={styles.ts}>
                    {m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                </div>
              </div>

              {/* Sources UI */}
              {m.links && m.links.length > 0 && (
                <div style={styles.sourcesBlock}>
                  {/* clicking the whole header toggles sources for accessibility */}
                  <div
                    style={styles.sourcesHeaderCompact}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSourcesForMessage(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") toggleSourcesForMessage(m);
                    }}
                    aria-expanded={m.showSources ? "true" : "false"}
                  >
                    <span style={styles.sourcesPill}>Sources</span>

                    <div style={styles.sourcesToggleCompact} aria-hidden>
                      {/* chevron icon: points right when closed, down when open */}
                      {m.showSources ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </div>

                  {m.showSources && (
                    <div style={styles.linksContainerCompact}>
                      {m.links.map((l, i) => (
                        <div key={i} style={styles.linkCard}>
                          <div style={styles.linkInfo}>
                            <a
                              href={l}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={styles.linkTitle}
                              title={l}
                            >
                              {shortenUrl(l)}
                            </a>
                          </div>

                          <div style={styles.linkActionsCompact}>
                            <button
                              style={styles.iconBtn}
                              onClick={() => copyToClipboard(l)}
                              title="Copy URL"
                              aria-label={`Copy source ${i + 1}`}
                            >
                              {copiedLink === l ? (
                                "✓"
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                                  <path d="M16 1H4C2.89543 1 2 1.89543 2 3V17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                  <rect x="8" y="5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div style={styles.botBubble}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={styles.dot} />
                <div style={styles.dot} />
                <div style={styles.dot} />
              </div>
            </div>
          )}
        </div>

        <form style={styles.form} onSubmit={sendQuery}>
          <input
            aria-label="Type your question"
            placeholder={loading ? "Thinking..." : "Type your question here..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={styles.input}
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                sendQuery(e);
              }
            }}
          />
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "..." : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ---------------------- utils used earlier (kept) ---------------------- */

function stripSourcesBlock(raw) {
  if (!raw) return "";
  const idx = raw.search(/\n\s*Sources\s*:/i);
  if (idx >= 0) {
    return raw.slice(0, idx).trim();
  }
  return raw.trim();
}

function stripFilenamesBeforeLinks(raw) {
  if (!raw) return raw;
  return raw.replace(/(\b[\w\-\.]{3,}\.pdf\b)(?=\s*,\s*https?:\/\/)/gi, "");
}

/* ---------------------- styles ---------------------- */

const styles = {
  page: {
    display: "flex",
    justifyContent: "center",
    padding: 20,
    background: "#0b0b0c",
    minHeight: "100vh",
    boxSizing: "border-box",
  },
  container: {
    width: "75%",
    maxWidth: 980,
    background: "#0f1720",
    borderRadius: 12,
    boxShadow: "0 6px 30px rgba(0,0,0,0.6)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  header: {
    color: "#fff",
    fontSize: 20,
    padding: "12px 18px",
    fontWeight: 600,
  },
  headerRight: {
    paddingRight: 12,
  },
  smallBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.06)",
    color: "#a8d1ff",
    padding: "6px 10px",
    borderRadius: 8,
    cursor: "pointer",
  },

  chatArea: {
    padding: 16,
    flex: 1,
    overflowY: "auto",
    maxHeight: "68vh",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  userBubble: {
    alignSelf: "flex-end",
    background: "#1f2937",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: 12,
    maxWidth: "80%",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  botBubble: {
    alignSelf: "flex-start",
    background: "#0b1220",
    color: "#e6eef8",
    padding: "10px 14px",
    borderRadius: 12,
    maxWidth: "80%",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  messageTextBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  messageTextInner: {
    fontSize: 14,
    lineHeight: "1.4",
    maxHeight: "40vh",
    overflowY: "auto",
  },

  /* Timestamp */
  timestampRow: {
    display: "flex",
    justifyContent: "flex-end",
  },
  ts: {
    fontSize: 11,
    color: "#99b3cc",
    opacity: 0.9,
  },

  /* Sources compact */
  sourcesBlock: {
    marginTop: 10,
  },
  sourcesHeaderCompact: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 8,
    cursor: "pointer",
  },
  sourcesPill: {
    background: "rgba(11,132,255,0.14)",
    color: "#0b84ff",
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
  },
  sourcesToggleCompact: {
    marginLeft: "auto",
    background: "transparent",
    color: "#a8d1ff",
    padding: "6px 8px",
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
  },
  linksContainerCompact: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  linkCard: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "rgba(255,255,255,0.02)",
    padding: "8px",
    borderRadius: 8,
  },
  domainBadge: {
    minWidth: 36,
    minHeight: 36,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.04)",
    color: "#cfeeff",
    fontWeight: 700,
    fontSize: 13,
  },
  linkInfo: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    flex: 1,
  },
  linkTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#cfeeff",
    textDecoration: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  linkActionsCompact: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  iconBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.05)",
    color: "#9fd1ff",
    padding: "6px 8px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
  },

  form: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,0.04)",
    alignItems: "center",
  },
  input: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.06)",
    background: "#061122",
    color: "#fff",
    outline: "none",
    fontSize: 14,
  },
  button: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "none",
    background: "#0b84ff",
    color: "white",
    cursor: "pointer",
    fontWeight: 600,
  },

  dot: {
    width: 8,
    height: 8,
    background: "rgba(255,255,255,0.18)",
    borderRadius: 999,
    animation: "typing 1s infinite",
  },
};
