import React, { useState, useRef, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import {
  Send,
  Square,
  Bot,
  User as UserIcon,
  Settings,
  Plus,
  X,
  Menu,
  Copy,
  Check,
  MessageSquare,
} from "lucide-react";
import nsutLogo from "../nsutlogo.png";

const API_URL =
  import.meta.env.VITE_API_URL || "http://127.0.0.1:8000/api/query";
const FEEDBACK_URL =
  import.meta.env.VITE_FEEDBACK_URL || "http://127.0.0.1:8000/api/feedback";

const Star = ({ filled, onClick, t }) => (
  <svg
    onClick={onClick}
    style={{
      cursor: "pointer",
      width: 32,
      height: 32,
      fill: filled ? "#f59e0b" : "transparent",
      stroke: filled ? "#f59e0b" : t.textSecondary,
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      transition: "0.2s",
    }}
    viewBox="0 0 24 24"
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
  </svg>
);

export default function ChatFrontend() {
  const [query, setQuery] = useState("");
  const [activeChatId, setActiveChatId] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 768);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [sidebarWidth, setSidebarWidth] = useState(280);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
      if (window.innerWidth > 768) setIsSidebarOpen(true);
      else setIsSidebarOpen(false);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Storage for all chats: { id, title, messages: [] }
  const [chats, setChats] = useState(() => {
    const saved = localStorage.getItem("ims_chats");
    return saved ? JSON.parse(saved) : [];
  });

  // Track active fetch controllers by chat ID
  const abortControllers = useRef({});

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [enableRecommendations, setEnableRecommendations] = useState(true);
  const [theme, setTheme] = useState("dark");
  const [answerStyle, setAnswerStyle] = useState("detailed"); // "detailed" | "precise"

  const containerRef = useRef(null);
  const [copiedLink, setCopiedLink] = useState(null);
  const [feedbackOpenFor, setFeedbackOpenFor] = useState(null);
  const [feedbackDraft, setFeedbackDraft] = useState({
    answer: null,
    source: null,
    satisfied: null,
  });
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  // Sync global chats to localStorage
  useEffect(() => {
    localStorage.setItem("ims_chats", JSON.stringify(chats));
  }, [chats]);

  // Scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [chats, activeChatId]);

  /* ---------------------- Data Access ---------------------- */
  const activeChat = chats.find((c) => c.id === activeChatId);
  const messages = activeChat ? activeChat.messages : [];
  // Loading is strictly tracked per chat now
  const isLoading = activeChat ? activeChat.loading : false;
  const loadingText = activeChat ? activeChat.loadingText : "";

  /* ---------------------- Chat Management ---------------------- */
  function startNewChat() {
    // If we're already on an empty new chat, don't do anything
    if (!activeChatId && messages.length === 0) return;

    // Switch to null active chat (acting as a draft space until first message)
    setActiveChatId(null);
  }

  function deleteChat(e, idToRemove) {
    e.stopPropagation();
    setChats((prev) => prev.filter((c) => c.id !== idToRemove));
    if (activeChatId === idToRemove) {
      setActiveChatId(null);
    }
  }

  /* ---------------------- Abort Logic ---------------------- */
  function handleStop() {
    if (!activeChatId) return;
    if (abortControllers.current[activeChatId]) {
      abortControllers.current[activeChatId].abort();
      delete abortControllers.current[activeChatId];
    }
    setChats((prev) =>
      prev.map((c) => {
        if (c.id === activeChatId) {
          return {
            ...c,
            loading: false,
            messages: [
              ...c.messages,
              {
                id: Date.now() + "_err",
                role: "bot",
                text: "Response stopped.",
                links: [],
                showSources: false,
                ts: new Date().toISOString(),
              },
            ],
          };
        }
        return c;
      }),
    );
  }

  /* ---------------------- Link Helpers ---------------------- */
  function cleanAndUniqueLinks(rawLinks) {
    if (!rawLinks?.length) return [];
    const unique = new Map();
    rawLinks.forEach((url) => {
      const base = url.split("?")[0];
      if (!unique.has(base)) unique.set(base, url);
    });
    return Array.from(unique.values());
  }

  function normalizeLink(raw) {
    if (!raw) return raw;
    let s = String(raw)
      .trim()
      .replace(/[\u200B-\u200D\uFEFF]/g, "");
    if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
    s = s.replace(/[\u2014\u2013]+$/, "").replace(/[),.?!;:]+$/g, "");
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
    try {
      const u = new URL(s);
      if (!u.searchParams.has("download")) {
        const pathParts = u.pathname.split("/");
        let filename = pathParts[pathParts.length - 1] || "document.pdf";
        if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";
        u.searchParams.set("download", filename);
      }
      return u.href;
    } catch (err) {
      return s.replace(/[",]+$/g, "");
    }
  }

  function stripFilenamesBeforeLinks(raw) {
    if (!raw) return raw;
    return raw.replace(/(\b[\w\-\.]{3,}\.pdf\b)(?=\s*,\s*https?:\/\/)/gi, "");
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const path = u.pathname === "/" ? "" : u.pathname;
      const truncatedPath = path.length > 20 ? path.slice(0, 15) + "..." : path;
      return `${host}${truncatedPath}`;
    } catch (e) {
      return url.length > 30 ? url.slice(0, 28) + "..." : url;
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(text);
      setTimeout(() => setCopiedLink(null), 1400);
    } catch (e) {
      console.error(e);
    }
  }

  function toggleSources(chatId, messageId) {
    setChats((prev) =>
      prev.map((c) => {
        if (c.id === chatId) {
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, showSources: !m.showSources } : m,
            ),
          };
        }
        return c;
      }),
    );
  }

  /* ---------------------- Feedback Helpers ---------------------- */
  function shouldShowFeedback(m) {
    if (!m || m.role !== "bot") return false;
    const txt = (m.text || "").toLowerCase();
    if (
      txt.includes("internal error") ||
      txt.includes("response stopped") ||
      txt.includes("i don't know") ||
      txt.includes("no specific question")
    )
      return false;
    if (!m.links || m.links.length === 0) return false;
    return true;
  }

  function shouldShowRetry(m) {
    if (!m || m.role !== "bot") return false;
    const txt = (m.text || "").toLowerCase();
    if (
      txt.includes("internal error") ||
      txt.includes("i don't know") ||
      txt.includes("no specific question") ||
      txt.includes("response stopped")
    )
      return false;
    return true;
  }

  function openFeedbackPopupFor(m) {
    setFeedbackOpenFor({ msgId: m.id, chatId: activeChatId });
    setFeedbackDraft({ answer: null, source: null, satisfied: null });
  }

  async function submitFeedback() {
    if (!feedbackOpenFor) return;
    const chat = chats.find((c) => c.id === feedbackOpenFor.chatId);
    if (!chat) return;
    const messageObj = chat.messages.find(
      (m) => m.id === feedbackOpenFor.msgId,
    );
    if (!messageObj) return;

    const ans = Number(feedbackDraft.answer);
    const src = Number(feedbackDraft.source);
    const sat = feedbackDraft.satisfied;

    if (!ans || ans < 1 || ans > 5)
      return alert("Please rate the Answer (1–5).");
    if (!src || src < 1 || src > 5)
      return alert("Please rate the Sources (1–5).");
    if (typeof sat !== "boolean")
      return alert("Please indicate if you are satisfied.");

    const payload = {
      message_id: messageObj.id,
      prompt: (() => {
        const idx = chat.messages.findIndex((x) => x.id === messageObj.id);
        if (idx > 0) {
          for (let i = idx - 1; i >= 0; i--) {
            if (chat.messages[i].role === "user") return chat.messages[i].text;
          }
        }
        return "";
      })(),
      response: messageObj.text,
      links: messageObj.links || [],
      answer_score: ans,
      source_score: src,
      satisfied: sat,
      comment: null,
    };

    setFeedbackLoading(true);
    try {
      const res = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setChats((prev) =>
        prev.map((c) => {
          if (c.id === feedbackOpenFor.chatId) {
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageObj.id
                  ? { ...m, feedbackSubmitted: true, feedback: payload }
                  : m,
              ),
            };
          }
          return c;
        }),
      );
      setFeedbackOpenFor(null);
    } catch (err) {
      alert("Failed to submit feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  }

  /* ---------------------- Networking ---------------------- */
  async function sendQuery(e) {
    e && e.preventDefault();
    if (!query.trim()) return;
    const text = query;
    setQuery("");
    await submit(text);
  }

  async function handleRetry(messageId) {
    if (!activeChatId) return;
    const chat = chats.find((c) => c.id === activeChatId);
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    let userQuery = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") {
        userQuery = chat.messages[i].text;
        break;
      }
    }
    if (userQuery) {
      await submit(userQuery, true);
    }
  }

  async function submitPrecomputedFollowUp(sq) {
    if (!sq || !sq.question) return;

    let targetChatId = activeChatId;
    let isNewChat = false;

    if (!targetChatId) {
      targetChatId = Date.now().toString();
      isNewChat = true;
      setActiveChatId(targetChatId);
    }

    const userId = Date.now() + "_u";
    const userMsg = {
      id: userId,
      role: "user",
      text: sq.question,
      links: [],
      ts: new Date().toISOString(),
    };

    const normalized = [];
    if (Array.isArray(sq.sources) && sq.sources.length > 0) {
      const seen = new Set();
      sq.sources.forEach((src) => {
        let link =
          typeof src === "string" ? src : src.source_link || src.link || "";
        link = normalizeLink(link);
        if (link && !seen.has(link)) {
          seen.add(link);
          normalized.push({
            link: link,
            title: src.notice_title || src.title || "",
            id: src.notice_id || src.id || "",
          });
        }
      });
    }

    const botMsg = {
      id: Date.now() + "_b",
      role: "bot",
      text: sq.answer || "No content.",
      links: normalized,
      suggestedFollowUp: [], // Don't show more follow ups for pre-computed to avoid loops/token explosion
      showSources: false,
      ts: new Date().toISOString(),
    };

    setChats((prev) => {
      if (isNewChat) {
        return [
          {
            id: targetChatId,
            title: sq.question.substring(0, 30),
            messages: [userMsg, botMsg],
            loading: false,
            loadingText: "",
          },
          ...prev,
        ];
      }
      return prev.map((c) => {
        if (c.id === targetChatId) {
          return {
            ...c,
            messages: [...c.messages, userMsg, botMsg],
          };
        }
        return c;
      });
    });
  }

  async function submit(text, overrideDeepSearch = false) {
    const trimmed = text?.trim();
    if (!trimmed) return;

    // Resolve what chat this goes to
    let targetChatId = activeChatId;
    let isNewChat = false;

    // If no active chat, create it on the fly
    if (!targetChatId) {
      targetChatId = Date.now().toString();
      isNewChat = true;
      setActiveChatId(targetChatId);
    }

    const userId = Date.now() + "_u";
    const userMsg = {
      id: userId,
      role: "user",
      text: trimmed,
      links: [],
      ts: new Date().toISOString(),
    };

    // Initialize/Update the Chat State
    setChats((prev) => {
      if (isNewChat) {
        return [
          {
            id: targetChatId,
            title: trimmed.substring(0, 30),
            messages: [userMsg],
            loading: true,
            loadingText: "Thinking...",
          },
          ...prev,
        ];
      }
      return prev.map((c) => {
        if (c.id === targetChatId) {
          return {
            ...c,
            messages: [...c.messages, userMsg],
            loading: true,
            loadingText: "Thinking...",
          };
        }
        return c;
      });
    });

    // Since fetch starts immediately, transition to "Retrieving docs..."
    // We add a tiny delay just to let the "Thinking..." state render for a split-second
    setTimeout(() => {
      setChats((prev) =>
        prev.map((c) =>
          c.id === targetChatId
            ? { ...c, loadingText: "Retrieving docs..." }
            : c,
        ),
      );
    }, 50);

    // Abort Controller Setup
    const controller = new AbortController();
    abortControllers.current[targetChatId] = controller;

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          deep_search: overrideDeepSearch,
          answer_style: answerStyle,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error("Backend error");

      // Response headers received; body is downloading/parsing
      setChats((prev) =>
        prev.map((c) =>
          c.id === targetChatId
            ? { ...c, loadingText: "Formatting answer..." }
            : c,
        ),
      );

      let answer = "";
      let sources = [];
      let suggestedFollowUp = [];
      const contentType = resp.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const j = await resp.json();
        answer = j.answer || j.output || j.text || "";
        sources = j.sources || [];
        suggestedFollowUp = j.suggested_follow_up || [];
      } else {
        answer = await resp.text();
      }

      if (answer && answer.trim().startsWith("[ERROR]"))
        throw new Error("Server Error");

      answer = stripFilenamesBeforeLinks(answer);

      const normalized = [];
      if (Array.isArray(sources) && sources.length > 0) {
        const seen = new Set();
        sources.forEach((src) => {
          let link =
            typeof src === "string" ? src : src.source_link || src.link || "";
          link = normalizeLink(link);
          if (link && !seen.has(link)) {
            seen.add(link);
            normalized.push({
              link: link,
              title: src.notice_title || src.title || "",
              id: src.notice_id || src.id || "",
            });
          }
        });
      }

      const botMsg = {
        id: Date.now() + "_b",
        role: "bot",
        text: answer || "No content.",
        links: normalized,
        suggestedFollowUp: suggestedFollowUp,
        showSources: false,
        ts: new Date().toISOString(),
      };

      setChats((prev) =>
        prev.map((c) => {
          if (c.id === targetChatId) {
            return { ...c, loading: false, messages: [...c.messages, botMsg] };
          }
          return c;
        }),
      );
    } catch (err) {
      if (err.name === "AbortError") {
        // Abort handled by handleStop
        return;
      }

      const errMsgs = {
        id: Date.now() + "_err",
        role: "bot",
        text: "[ERROR] Could not generate response. Please try again.",
        links: [],
        showSources: false,
        ts: new Date().toISOString(),
      };

      setChats((prev) =>
        prev.map((c) => {
          if (c.id === targetChatId) {
            return { ...c, loading: false, messages: [...c.messages, errMsgs] };
          }
          return c;
        }),
      );
    } finally {
      if (abortControllers.current[targetChatId]) {
        delete abortControllers.current[targetChatId];
      }
    }
  }

  /* ---------------------- Setup Dynamic Theme Styles ---------------------- */
  const isLight = theme === "light";

  // Clean Professional Chatbot Aesthetic
  const t = {
    bgApp: isLight ? "#fdfdfd" : "#212121",
    bgSidebar: isLight ? "#f7f7f8" : "#171717",
    bgMain: isLight ? "#ffffff" : "#212121",
    textPrimary: isLight ? "#0d0d0d" : "#ececec",
    textSecondary: isLight ? "#6b6b6b" : "#b4b4b4",
    border: isLight ? "#e5e5e5" : "#424242",
    accent: isLight ? "#000000" : "#ffffff", // ChatGPT like
    accentInvert: isLight ? "#ffffff" : "#000000",
    hoverBg: isLight ? "#ececec" : "#2f2f2f",
    bubbleUser: isLight ? "#f4f4f4" : "#2f2f2f",
    bubbleBot: "transparent",
    inputBg: isLight ? "#f4f4f4" : "#2f2f2f",
  };

  return (
    <>
      <Analytics />
      <SpeedInsights />
      <style>{`
        input:focus, button:focus, form:focus-within {
          outline: none !important;
          box-shadow: none !important;
        }
        .user-avatar {
          background: ${t.textPrimary};
          color: ${t.bgMain};
          width: 30px;
          height: 30px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 14px;
          flex-shrink: 0;
          margin-top: 4px;
        }
      `}</style>
      <div
        style={{
          display: "flex",
          height: "100vh",
          width: "100vw",
          background: t.bgApp,
          color: t.textPrimary,
          fontFamily: "system-ui, -apple-system, sans-serif",
          overflow: "hidden",
        }}
      >
        {isMobile && isSidebarOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 40,
            }}
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <div
          style={{
            width: isMobile ? "280px" : `${sidebarWidth}px`,
            background: t.bgSidebar,
            borderRight: `1px solid ${t.border}`,
            display: "flex",
            flexDirection: "column",
            overflow:
              "hidden" /* FIXED: Explicit boundary for Settings button */,
            boxSizing: "border-box",
            padding: "16px 12px",
            flexShrink: 0,
            position: isMobile ? "fixed" : "relative",
            height: "100%",
            zIndex: 50,
            transform: isSidebarOpen ? "translateX(0)" : "translateX(-100%)",
            transition: isMobile
              ? "transform 0.3s ease"
              : "transform 0.3s ease, margin-left 0.3s ease, width 0s",
            marginLeft:
              !isMobile && !isSidebarOpen ? `-${sidebarWidth}px` : "0",
          }}
        >
          <div
            style={{
              padding: "0 8px",
              marginBottom: "20px",
              fontSize: "16px",
              fontWeight: "600",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <img
              src={nsutLogo}
              alt="NSUT Logo"
              style={{ width: 24, height: 24, objectFit: "contain" }}
            />
            NSUT Bot
          </div>

          <button
            style={{
              display: "flex",
              gap: "10px",
              alignItems: "center",
              background: "transparent",
              border: "none",
              color: t.textPrimary,
              padding: "12px",
              borderRadius: "8px",
              cursor: "pointer",
              transition: "0.2s",
              textAlign: "left",
              width: "100%",
              fontSize: "14px",
              fontWeight: "500",
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = t.hoverBg)}
            onMouseOut={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
            onClick={startNewChat}
          >
            <Plus size={18} style={{ marginRight: 4 }} /> New Chat
          </button>

          <div
            style={{
              flex: 1,
              overflowY: "auto",
              minHeight: 0,
              marginTop: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: t.textSecondary,
                padding: "0 12px 8px",
              }}
            >
              Recent
            </div>
            {chats.map((c) => (
              <div
                key={c.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: "8px",
                  cursor: "pointer",
                  fontSize: "14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: activeChatId === c.id ? t.hoverBg : "transparent",
                  color: t.textPrimary,
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
                onMouseOver={(e) =>
                  activeChatId !== c.id &&
                  (e.currentTarget.style.background = t.hoverBg)
                }
                onMouseOut={(e) =>
                  activeChatId !== c.id &&
                  (e.currentTarget.style.background = "transparent")
                }
                onClick={() => setActiveChatId(c.id)}
              >
                <span style={{ textOverflow: "ellipsis", overflow: "hidden" }}>
                  {c.title || "New Chat"}
                </span>
                <button
                  onClick={(e) => deleteChat(e, c.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: t.textSecondary,
                    cursor: "pointer",
                    fontSize: "14px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                  }}
                  title="Delete chat"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: "auto",
              paddingTop: "12px",
              borderTop: `1px solid ${t.border}`,
            }}
          >
            <button
              style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                background: "transparent",
                border: "none",
                color: t.textPrimary,
                cursor: "pointer",
                fontSize: "14px",
                borderRadius: "8px",
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = t.hoverBg)
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
              onClick={() => setShowSettings(true)}
            >
              <Settings size={16} /> Settings
            </button>
          </div>

          {/* Drag Handle for resizing */}
          {!isMobile && isSidebarOpen && (
            <div
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: "4px",
                height: "100%",
                cursor: "col-resize",
                zIndex: 100,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const handleMouseMove = (moveEvent) => {
                  let newWidth = moveEvent.clientX;
                  if (newWidth < 100) {
                    setIsSidebarOpen(false);
                    window.removeEventListener("mousemove", handleMouseMove);
                    window.removeEventListener("mouseup", handleMouseUp);
                  } else {
                    if (newWidth > 600) newWidth = 600;
                    setSidebarWidth(newWidth);
                    if (!isSidebarOpen) setIsSidebarOpen(true);
                  }
                };
                const handleMouseUp = () => {
                  window.removeEventListener("mousemove", handleMouseMove);
                  window.removeEventListener("mouseup", handleMouseUp);
                };
                window.addEventListener("mousemove", handleMouseMove);
                window.addEventListener("mouseup", handleMouseUp);
              }}
            />
          )}
        </div>

        {/* Main View */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: t.bgMain,
            position: "relative",
            width: "100%",
            overflowX: "hidden",
          }}
        >
          {/* Top Bar for Sidebar Toggle */}
          <div
            style={{
              padding: "12px 20px",
              borderBottom: isLight ? `1px solid ${t.border}` : "none",
              display: "flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              style={{
                background: "transparent",
                border: "none",
                color: t.textPrimary,
                cursor: "pointer",
                padding: "8px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = t.hoverBg)
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <Menu size={22} color={t.textPrimary} />
            </button>
            <span
              style={{
                fontWeight: "500",
                fontSize: "16px",
                letterSpacing: "0.5px",
              }}
            >
              NSUT Bot
            </span>
          </div>

          {/* Messages Area */}
          <div
            ref={containerRef}
            style={{ flex: 1, overflowY: "auto", padding: "20px 0 40px" }}
          >
            {messages.length === 0 ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "column",
                  opacity: 0.8,
                }}
              >
                <img
                  src={nsutLogo}
                  alt="NSUT Logo"
                  style={{
                    width: 64,
                    height: 64,
                    objectFit: "contain",
                    marginBottom: 20,
                  }}
                />
                <h2 style={{ fontSize: "24px", fontWeight: "600", margin: 0 }}>
                  How can I help you today?
                </h2>
              </div>
            ) : (
              <div
                style={{
                  maxWidth: "800px",
                  margin: "0 auto",
                  padding: "0 20px",
                }}
              >
                {messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      marginBottom: "30px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: m.role === "user" ? "flex-end" : "flex-start",
                    }}
                  >
                    {/* Role Icon & Content */}
                    <div
                      style={{
                        display: "flex",
                        gap: "16px",
                        width: m.role === "bot" ? "100%" : "auto",
                        maxWidth: m.role === "bot" ? "100%" : "85%",
                      }}
                    >
                      {m.role === "bot" ? (
                        <div
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: "50%",
                            background: t.textPrimary,
                            color: t.bgMain,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            marginTop: "4px",
                          }}
                        >
                          <Bot size={20} color={t.bgMain} />
                        </div>
                      ) : (
                        <div
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: "50%",
                            background: t.border,
                            color: t.textPrimary,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            marginTop: "4px",
                          }}
                        >
                          <UserIcon size={20} color={t.textPrimary} />
                        </div>
                      )}

                      <div
                        style={{
                          background:
                            m.role === "user" ? t.bubbleUser : t.bubbleBot,
                          padding: m.role === "user" ? "12px 18px" : "4px 0",
                          borderRadius: m.role === "user" ? "20px" : "0",
                          fontSize: "15px",
                          lineHeight: "1.6",
                          flex: 1,
                        }}
                      >
                        {m.text.split("\\n").map((line, i) => (
                          <p
                            key={i}
                            style={{
                              margin: "4px 0",
                              minHeight: line.trim() ? "auto" : 8,
                            }}
                          >
                            {line}
                          </p>
                        ))}

                        {/* Bot Actions */}
                        {m.role === "bot" && (
                          <div
                            style={{
                              marginTop: "16px",
                              display: "flex",
                              gap: "12px",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            {shouldShowFeedback(m) &&
                              (m.feedbackSubmitted ? (
                                <span
                                  style={{
                                    fontSize: "12px",
                                    color: t.textSecondary,
                                  }}
                                  title="Feedback submitted"
                                >
                                  ✓ Feedback Received
                                </span>
                              ) : (
                                <button
                                  style={{
                                    background: "transparent",
                                    border: `1px solid ${t.border}`,
                                    color: t.textSecondary,
                                    padding: "4px 10px",
                                    borderRadius: "6px",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                  }}
                                  onClick={() => openFeedbackPopupFor(m)}
                                >
                                  ✎ Feedback
                                </button>
                              ))}

                            {shouldShowRetry(m) && (
                              <button
                                style={{
                                  background: "transparent",
                                  border: `1px solid ${t.border}`,
                                  color: t.textSecondary,
                                  padding: "4px 10px",
                                  borderRadius: "6px",
                                  fontSize: "12px",
                                  cursor: "pointer",
                                }}
                                onClick={() => handleRetry(m.id)}
                                disabled={isLoading}
                              >
                                ↻ Retry
                              </button>
                            )}

                            {m.links && m.links.length > 0 && (
                              <button
                                style={{
                                  background: "transparent",
                                  border: `1px solid ${t.border}`,
                                  color: t.textSecondary,
                                  padding: "4px 10px",
                                  borderRadius: "6px",
                                  fontSize: "12px",
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  toggleSources(activeChatId, m.id)
                                }
                              >
                                {m.showSources
                                  ? "Hide Sources"
                                  : `View Sources (${m.links.length})`}
                              </button>
                            )}
                          </div>
                        )}

                        {m.showSources && (
                          <div
                            style={{
                              marginTop: "12px",
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "8px",
                            }}
                          >
                            {m.links.map((srcItem, idx) => {
                              let link =
                                typeof srcItem === "string"
                                  ? srcItem
                                  : srcItem.link || "";
                              let finalTitle =
                                typeof srcItem === "string"
                                  ? ""
                                  : srcItem.title || srcItem.id || "";

                              if (!finalTitle) {
                                finalTitle = shortenUrl(link);
                                try {
                                  const u = new URL(link);
                                  const dl = u.searchParams.get("download");
                                  if (dl) finalTitle = dl;
                                  else {
                                    let parts = u.pathname.split("/");
                                    if (parts[parts.length - 1])
                                      finalTitle = parts[parts.length - 1];
                                  }
                                } catch (e) { }
                              }

                              return (
                                <div
                                  key={idx}
                                  style={{
                                    display: "flex",
                                    border: `1px solid ${t.border}`,
                                    borderRadius: "6px",
                                    overflow: "hidden",
                                    background: t.bgSidebar,
                                    maxWidth: "100%",
                                  }}
                                >
                                  <a
                                    href={link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      padding: "8px 12px",
                                      fontSize: "12px",
                                      color: t.textPrimary,
                                      textDecoration: "none",
                                      flex: 1,
                                      whiteSpace: "nowrap",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                    title={finalTitle}
                                  >
                                    {finalTitle}
                                  </a>
                                  <button
                                    onClick={() => copyToClipboard(link)}
                                    style={{
                                      border: "none",
                                      borderLeft: `1px solid ${t.border}`,
                                      background: "transparent",
                                      padding: "0 10px",
                                      color: t.textSecondary,
                                      cursor: "pointer",
                                    }}
                                    title="Copy Link"
                                  >
                                    {copiedLink === link ? "✓" : "❐"}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {enableRecommendations &&
                          m.suggestedFollowUp &&
                          m.suggestedFollowUp.length > 0 && (
                            <div style={{ marginTop: "16px" }}>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: t.textSecondary,
                                  marginBottom: "8px",
                                }}
                              >
                                Suggested Follow-ups:
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "6px",
                                }}
                              >
                                {m.suggestedFollowUp.map((sq, idx) => {
                                  const isObject =
                                    typeof sq === "object" && sq !== null;
                                  const questionText = isObject
                                    ? sq.question
                                    : sq;

                                  return (
                                    <button
                                      key={idx}
                                      style={{
                                        textAlign: "left",
                                        background: "transparent",
                                        border: `1px solid ${t.border}`,
                                        color: t.textPrimary,
                                        padding: "10px 14px",
                                        borderRadius: "8px",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                      }}
                                      onMouseOver={(e) =>
                                      (e.currentTarget.style.background =
                                        t.hoverBg)
                                      }
                                      onMouseOut={(e) =>
                                      (e.currentTarget.style.background =
                                        "transparent")
                                      }
                                      onClick={() =>
                                        isObject && sq.answer
                                          ? submitPrecomputedFollowUp(sq)
                                          : submit(questionText)
                                      }
                                    >
                                      {questionText}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                      </div>
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div
                    style={{
                      display: "flex",
                      gap: "16px",
                      marginBottom: "30px",
                      width: "100%",
                    }}
                  >
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: "50%",
                        background: t.textPrimary,
                        color: t.bgMain,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        marginTop: "4px",
                      }}
                    >
                      <Bot size={20} color={t.bgMain} />
                    </div>
                    <div
                      style={{
                        padding: "4px 0",
                        fontSize: "15px",
                        flex: 1,
                        color: t.textSecondary,
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontStyle: "italic",
                      }}
                    >
                      <span className="pulse-text">{loadingText}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Input Area */}
          <div
            style={{
              padding: "20px",
              maxWidth: "800px",
              width: "100%",
              boxSizing: "border-box",
              margin: "0 auto",
            }}
          >
            <div style={{ position: "relative" }}>
              <form
                onSubmit={sendQuery}
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: t.inputBg,
                  borderRadius: "24px",
                  border: `1px solid ${t.border}`,
                  padding: "8px 16px",
                  gap: "12px",
                }}
              >
                <input
                  type="text"
                  placeholder="Send a message..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    fontSize: "15px",
                    color: t.textPrimary,
                    padding: "8px 0",
                  }}
                  disabled={isLoading}
                />

                {isLoading ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    style={{
                      background: t.textPrimary,
                      color: t.bgMain,
                      border: "none",
                      width: "36px",
                      height: "36px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    <Square size={16} fill={t.bgMain} color={t.bgMain} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!query.trim()}
                    style={{
                      background: query.trim() ? t.textPrimary : t.border,
                      opacity: query.trim() ? 1 : 0.6,
                      color: t.bgMain,
                      border: "none",
                      width: "36px",
                      height: "36px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: query.trim() ? "pointer" : "not-allowed",
                      transition: "0.2s",
                    }}
                  >
                    <Send
                      size={18}
                      color={query.trim() ? t.bgMain : t.textSecondary}
                      style={{ marginLeft: "-2px" }}
                    />
                  </button>
                )}
              </form>
              <div
                style={{
                  textAlign: "center",
                  marginTop: "10px",
                  fontSize: "11px",
                  color: t.textSecondary,
                }}
              >
                NSUT Chatbot can make mistakes. Verify important information.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setShowSettings(false)}
        >
          <div
            style={{
              background: t.bgMain,
              borderRadius: "16px",
              width: "400px",
              maxWidth: "90%",
              padding: "24px",
              color: t.textPrimary,
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "24px",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "18px" }}>Settings</h3>
              <button
                onClick={() => setShowSettings(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: t.textSecondary,
                  fontSize: "20px",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                marginBottom: "20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: "14px" }}>Theme</span>
              <div
                style={{
                  display: "flex",
                  background: t.inputBg,
                  borderRadius: "8px",
                  padding: "4px",
                }}
              >
                <button
                  onClick={() => setTheme("light")}
                  style={{
                    background: theme === "light" ? t.bgMain : "transparent",
                    color: t.textPrimary,
                    border: "none",
                    padding: "6px 16px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    boxShadow:
                      theme === "light" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  }}
                >
                  Light
                </button>
                <button
                  onClick={() => setTheme("dark")}
                  style={{
                    background: theme === "dark" ? t.bgMain : "transparent",
                    color: t.textPrimary,
                    border: "none",
                    padding: "6px 16px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    boxShadow:
                      theme === "dark" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  }}
                >
                  Dark
                </button>
              </div>
            </div>

            <div
              style={{
                marginBottom: "20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: "14px" }}>Answer Format</span>
              <div
                style={{
                  display: "flex",
                  background: t.inputBg,
                  borderRadius: "8px",
                  padding: "4px",
                }}
              >
                <button
                  onClick={() => setAnswerStyle("detailed")}
                  style={{
                    background:
                      answerStyle === "detailed" ? t.bgMain : "transparent",
                    color: t.textPrimary,
                    border: "none",
                    padding: "6px 16px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    boxShadow:
                      answerStyle === "detailed"
                        ? "0 1px 3px rgba(0,0,0,0.1)"
                        : "none",
                  }}
                >
                  Detailed
                </button>
                <button
                  onClick={() => setAnswerStyle("precise")}
                  style={{
                    background:
                      answerStyle === "precise" ? t.bgMain : "transparent",
                    color: t.textPrimary,
                    border: "none",
                    padding: "6px 16px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    boxShadow:
                      answerStyle === "precise"
                        ? "0 1px 3px rgba(0,0,0,0.1)"
                        : "none",
                  }}
                >
                  Precise
                </button>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: "14px" }}>Recommendations</span>
              <div
                onClick={() => setEnableRecommendations(!enableRecommendations)}
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 10,
                  background: enableRecommendations ? t.textPrimary : t.border,
                  position: "relative",
                  cursor: "pointer",
                  transition: "background 0.3s",
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: t.bgMain,
                    position: "absolute",
                    top: 2,
                    left: enableRecommendations ? 18 : 2,
                    transition: "left 0.3s",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Feedback Modal */}
      {feedbackOpenFor && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setFeedbackOpenFor(null)}
        >
          <div
            style={{
              background: t.bgMain,
              borderRadius: "16px",
              width: "350px",
              maxWidth: "90%",
              padding: "24px",
              color: t.textPrimary,
              boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              style={{
                margin: "0 0 16px 0",
                fontSize: "16px",
                fontWeight: "600",
                color: t.textPrimary,
              }}
            >
              Share Your Feedback
            </h3>

            <div style={{ marginBottom: "20px" }}>
              <div
                style={{
                  fontSize: "13px",
                  marginBottom: "8px",
                  color: t.textSecondary,
                }}
              >
                How would you rate the answer?
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={"ans" + n}
                    onClick={() =>
                      setFeedbackDraft((p) => ({ ...p, answer: n }))
                    }
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontSize: "13px",
                      background:
                        feedbackDraft.answer === n
                          ? t.textPrimary
                          : "transparent",
                      color:
                        feedbackDraft.answer === n ? t.bgMain : t.textPrimary,
                      border: `1px solid ${feedbackDraft.answer === n ? t.textPrimary : t.border}`,
                      borderRadius: "6px",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "20px" }}>
              <div
                style={{
                  fontSize: "13px",
                  marginBottom: "8px",
                  color: t.textSecondary,
                }}
              >
                Were the sources helpful?
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={"src" + n}
                    onClick={() =>
                      setFeedbackDraft((p) => ({ ...p, source: n }))
                    }
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      fontSize: "13px",
                      background:
                        feedbackDraft.source === n
                          ? t.textPrimary
                          : "transparent",
                      color:
                        feedbackDraft.source === n ? t.bgMain : t.textPrimary,
                      border: `1px solid ${feedbackDraft.source === n ? t.textPrimary : t.border}`,
                      borderRadius: "6px",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "24px" }}>
              <div
                style={{
                  fontSize: "13px",
                  marginBottom: "12px",
                  color: t.textSecondary,
                  textAlign: "center"
                }}
              >
                Are you satisfied with this response?
              </div>
              <div style={{ display: "flex", gap: "16px", justifyContent: "center" }}>
                <button
                  onClick={() => setFeedbackDraft((p) => ({ ...p, satisfied: true }))}
                  style={{
                    padding: "6px 24px",
                    fontSize: "13px",
                    background: feedbackDraft.satisfied === true ? t.textPrimary : "transparent",
                    color: feedbackDraft.satisfied === true ? t.bgMain : t.textPrimary,
                    border: `1px solid ${feedbackDraft.satisfied === true ? t.textPrimary : t.border}`,
                    borderRadius: "6px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  Yes
                </button>
                <button
                  onClick={() => setFeedbackDraft((p) => ({ ...p, satisfied: false }))}
                  style={{
                    padding: "6px 24px",
                    fontSize: "13px",
                    background: feedbackDraft.satisfied === false ? t.textPrimary : "transparent",
                    color: feedbackDraft.satisfied === false ? t.bgMain : t.textPrimary,
                    border: `1px solid ${feedbackDraft.satisfied === false ? t.textPrimary : t.border}`,
                    borderRadius: "6px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  No
                </button>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "12px",
              }}
            >
              <button
                onClick={() => setFeedbackOpenFor(null)}
                style={{
                  background: "transparent",
                  color: t.textSecondary,
                  border: "none",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                Cancel
              </button>
              <button
                onClick={submitFeedback}
                disabled={
                  feedbackLoading ||
                  !feedbackDraft.answer ||
                  !feedbackDraft.source
                }
                style={{
                  background: t.textPrimary,
                  color: t.bgMain,
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: "6px",
                  cursor:
                    feedbackLoading ||
                      !feedbackDraft.answer ||
                      !feedbackDraft.source
                      ? "not-allowed"
                      : "pointer",
                  fontSize: "13px",
                  opacity:
                    feedbackLoading ||
                      !feedbackDraft.answer ||
                      !feedbackDraft.source
                      ? 0.5
                      : 1,
                }}
              >
                {feedbackLoading ? "Submitting..." : "Submit"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>
        {`
          .pulse-text {
            animation: pulse-op 1.5s infinite;
          }
          @keyframes pulse-op {
            0% { opacity: 0.5; }
            50% { opacity: 1; }
            100% { opacity: 0.5; }
          }
        `}
      </style>
    </>
  );
}
