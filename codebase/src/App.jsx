import { useEffect, useMemo, useState } from "react";
import Header from "./components/Header";
import SlideViewer from "./components/SlideViewer";
import AiTutorChatPanel from "./components/AiTutorChatPanel";
import DocumentWelcome from "./components/DocumentWelcome";
import { Icon } from "./components/Icons";

let messageCounter = 0;
function createMessage(role, content, extra = {}) {
  messageCounter += 1;
  return {
    id: `${Date.now()}-${messageCounter}`,
    role,
    content,
    ...extra
  };
}

export default function App() {
  const [deckData, setDeckData] = useState(null);
  const [currentDeckId, setCurrentDeckId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCounts, setPageCounts] = useState({});
  const [pageText, setPageText] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [messages, setMessages] = useState([
    createMessage(
      "assistant",
      "Chào Minh Anh! Hãy thêm tài liệu PDF của nhóm hoặc mở một tài liệu có sẵn để bắt đầu.\n\n📌 Sau đó, bạn có thể bôi đen nội dung trên trang để hỏi mình."
    )
  ]);
  const [isTyping, setIsTyping] = useState(false);
  const [serviceMode, setServiceMode] = useState("openrouter");
  const [isTutorOpen, setIsTutorOpen] = useState(true);

  useEffect(() => {
    fetch("/api/decks")
      .then((response) => {
        if (!response.ok) throw new Error("Không tải được danh sách tài liệu.");
        return response.json();
      })
      .then(setDeckData)
      .catch((error) => {
        setMessages((current) => [
          ...current,
          createMessage("assistant", error.message)
        ]);
      });
  }, []);

  const decks = deckData?.decks || [];
  const deck = useMemo(
    () => decks.find((item) => item.id === currentDeckId),
    [decks, currentDeckId]
  );
  const totalPages = deck
    ? pageCounts[deck.id] || deck.totalPages || 1
    : 1;

  const slide = deck
    ? {
        id: currentPage,
        totalPages,
        title: deck.title,
        contextLabel: deck.shortTitle
      }
    : null;

  function changeDeck(deckId) {
    const target = decks.find((item) => item.id === deckId);
    if (!target || target.id === currentDeckId) return;
    setCurrentDeckId(target.id);
    setCurrentPage(1);
    setPageText("");
    setMessages((current) => [
      ...current,
      createMessage(
        "assistant",
        `Đã mở ${target.shortTitle}: ${target.title}. Mình sẽ dùng nội dung của từng trang làm nguồn trả lời.`
      )
    ]);
  }

  function changePage(pageNumber, announce = false) {
    if (!deck) return;
    const target = Number(pageNumber);
    if (!Number.isInteger(target) || target < 1 || target > totalPages) {
      return;
    }
    setCurrentPage(target);
    setPageText("");
    if (announce) {
      setMessages((current) => [
        ...current,
        createMessage(
          "assistant",
          `Đã mở ${deck.shortTitle}, trang ${target}. Bạn có thể bôi đen nội dung để hỏi ngay.`
        )
      ]);
    }
  }

  async function uploadDeck(file) {
    if (!file || isUploading) return;
    setIsUploading(true);
    setUploadError("");
    try {
      const formData = new FormData();
      formData.append("pdf", file);
      const response = await fetch("/api/decks/upload", {
        method: "POST",
        body: formData
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Không thể tải PDF lên.");
      }

      setDeckData((current) => ({
        ...current,
        decks: [...current.decks, result.deck]
      }));
      setCurrentDeckId(result.deck.id);
      setCurrentPage(1);
      setPageText("");
      setMessages((current) => [
        ...current,
        createMessage(
          "assistant",
          `Đã tải lên “${result.deck.title}”. Mình sẽ dùng nội dung PDF này làm nguồn trả lời.`
        )
      ]);
    } catch (error) {
      setUploadError(error.message);
    } finally {
      setIsUploading(false);
    }
  }

  async function sendMessage(text, options = {}) {
    if (isTyping || !deck) return;

    const normalized = text.toLowerCase().trim();
    const includeQuiz =
      options.includeQuiz === true ||
      normalized.includes("quiz") ||
      normalized.includes("câu hỏi kiểm tra");
    const userMessage = createMessage("user", text);
    const history = [...messages, userMessage];
    setMessages(history);
    setIsTyping(true);

    // Create a placeholder streaming message so the bubble appears immediately
    const streamingId = `${Date.now()}-stream`;
    const streamingMessage = createMessage("assistant", "", { _streamingId: streamingId });
    // We'll track the accumulated text outside of state to avoid closure stale issues
    let streamedText = "";

    setMessages((current) => [...current, { ...streamingMessage, id: streamingId }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deckId: deck.id,
          pageNumber: currentPage,
          pageText,
          selectedText: options.selectedText || "",
          includeQuiz,
          messages: history.map(({ role, content }) => ({ role, content }))
        })
      });

      const contentType = response.headers.get("content-type") || "";

      // ── SSE streaming path ──────────────────────────────────────────────
      if (contentType.includes("text/event-stream")) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResult = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete last line

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              const dataStr = line.slice(5).trim();
              if (!dataStr) continue;
              try {
                const data = JSON.parse(dataStr);
                if (currentEvent === "delta" && data.text) {
                  streamedText += data.text;
                  // Update the streaming bubble in place
                  setMessages((current) =>
                    current.map((m) =>
                      m.id === streamingId ? { ...m, content: streamedText } : m
                    )
                  );
                } else if (currentEvent === "done") {
                  finalResult = data;
                } else if (currentEvent === "error") {
                  throw new Error(data.message || "AI stream error");
                }
              } catch (parseErr) {
                if (currentEvent === "error") throw parseErr;
              }
              currentEvent = null;
            }
          }
        }

        // Replace streaming bubble with the final structured message
        if (finalResult) {
          setServiceMode(finalResult.mode || "gemini");
          setMessages((current) =>
            current.map((m) =>
              m.id === streamingId
                ? createMessage("assistant", finalResult.answer, { quiz: finalResult.quiz || null })
                : m
            )
          );
        } else {
          // No done event — keep whatever text streamed
          setMessages((current) =>
            current.map((m) =>
              m.id === streamingId ? { ...m, content: streamedText || "…" } : m
            )
          );
        }

      // ── Fallback: plain JSON (demo / error path) ──────────────────────
      } else {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "AI Tutor gặp lỗi.");
        setServiceMode(result.mode || "gemini");
        setMessages((current) =>
          current.map((m) =>
            m.id === streamingId
              ? createMessage("assistant", result.answer, { quiz: result.quiz || null })
              : m
          )
        );
      }
    } catch (error) {
      setMessages((current) =>
        current.map((m) =>
          m.id === streamingId
            ? createMessage("assistant", `Không thể kết nối AI Tutor. ${error.message}`, { retryText: text })
            : m
        )
      );
    } finally {
      setIsTyping(false);
    }
  }

  function answerQuiz(quiz, option) {
    if (isTyping) return;
    const correct = option.id === quiz.correctOptionId;
    setMessages((current) => [
      ...current.map((message) =>
        message.quiz?.id === quiz.id ? { ...message, quiz: null } : message
      ),
      createMessage("user", option.text)
    ]);
    setIsTyping(true);

    window.setTimeout(() => {
      setMessages((current) => [
        ...current,
        createMessage(
          "assistant",
          correct ? quiz.correctFeedback : quiz.incorrectFeedback,
          {
            action: correct ? null : quiz.remediation
          }
        )
      ]);
      setIsTyping(false);
    }, 550);
  }

  if (!deckData) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#0B0F1A] text-sm text-slate-400">
        Đang tải không gian học tập…
      </div>
    );
  }

  return (
    <div className="relative flex h-screen min-w-[1180px] overflow-hidden bg-[#0B0F1A] text-slate-100">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header slide={slide} />
        {deck ? (
          <SlideViewer
            deck={deck}
            decks={decks}
            pageNumber={currentPage}
            totalPages={totalPages}
            onDeckChange={changeDeck}
            onPageChange={changePage}
            onDocumentLoad={(numPages) =>
              setPageCounts((current) => ({
                ...current,
                [deck.id]: numPages
              }))
            }
            onPageText={setPageText}
            onUpload={uploadDeck}
            isUploading={isUploading}
            uploadError={uploadError}
            onAskSelection={(selectedText) => {
              setIsTutorOpen(true);
              sendMessage(`Giải thích đoạn được chọn: “${selectedText}”`, {
                selectedText,
                includeQuiz: true
              });
            }}
          />
        ) : (
          <DocumentWelcome
            decks={decks}
            onOpenDeck={changeDeck}
            onUpload={uploadDeck}
            isUploading={isUploading}
            uploadError={uploadError}
          />
        )}
      </div>

      {isTutorOpen ? (
        <AiTutorChatPanel
          slide={slide}
          messages={messages}
          isTyping={isTyping}
          serviceMode={serviceMode}
          onSend={sendMessage}
          onQuizAnswer={answerQuiz}
          onOpenSlide={(page) => changePage(page, true)}
          onCollapse={() => setIsTutorOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsTutorOpen(true)}
          className="group absolute right-0 top-1/2 z-50 flex h-16 w-12 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-l-2xl border border-r-0 border-blue-400/20 bg-[#171E2C]/95 text-blue-200 shadow-xl shadow-black/35 backdrop-blur transition hover:w-14 hover:border-blue-400/40 hover:bg-blue-500/15 hover:text-white"
          aria-label="Mở AI Tutor"
          title="Mở AI Tutor"
        >
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600 text-white shadow-lg shadow-blue-950/35">
            <Icon name="bot" className="h-4 w-4" />
          </span>
        </button>
      )}
    </div>
  );
}
