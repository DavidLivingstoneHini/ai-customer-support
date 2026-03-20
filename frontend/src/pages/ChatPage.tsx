import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import toast from 'react-hot-toast'
import {
  Bot, ChevronDown, ChevronRight, LogOut, MessageSquare,
  Plus, Send, Settings, User, AlertTriangle, FileText,
} from 'lucide-react'
import clsx from 'clsx'
import { chatApi, type Message, type Session } from '../api/client'
import { useAuth } from '../context/AuthContext'

interface Source {
  document_name: string
  document_id: string
  page: number
  score: number
}

interface UIMessage extends Message {
  sources?: Source[]
  escalated?: boolean
  streaming?: boolean
}

export default function ChatPage() {
  const { user, logout, isAdmin } = useAuth()
  const navigate = useNavigate()

  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  // Load sessions on mount
  useEffect(() => {
    chatApi.listSessions()
      .then(setSessions)
      .catch(() => toast.error('Failed to load sessions'))
  }, [])

  const loadSession = useCallback(async (session: Session) => {
    setActiveSession(session)
    try {
      const msgs = await chatApi.getMessages(session.id)
      setMessages(msgs.map(m => ({ ...m })))
    } catch {
      toast.error('Failed to load messages')
    }
  }, [])

  const newSession = useCallback(async () => {
    setActiveSession(null)
    setMessages([])
    inputRef.current?.focus()
  }, [])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setStreaming(true)

    const userMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])

    const assistantMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
      streaming: true,
    }
    setMessages(prev => [...prev, assistantMsg])

    try {
      let sources: Source[] = []
      let escalated = false
      let fullContent = ''

      const stream = chatApi.streamChatFetch(text, activeSession?.id)

      for await (const chunk of stream) {
        if (chunk.startsWith('[SOURCES]')) {
          sources = JSON.parse(chunk.slice(9))
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsg.id ? { ...m, sources } : m
            )
          )
        } else if (chunk === '[ESCALATE]') {
          escalated = true
          const escalateContent =
            "I wasn't able to find a confident answer in our knowledge base. I'm connecting you to a human agent who can better assist you."
          fullContent = escalateContent
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsg.id
                ? { ...m, content: escalateContent, escalated: true, streaming: false }
                : m
            )
          )
        } else if (chunk === '[INJECTION_DETECTED]') {
          const injectionContent =
            "I detected potentially unsafe content in your message. Please rephrase your question."
          fullContent = injectionContent
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsg.id
                ? { ...m, content: injectionContent, streaming: false }
                : m
            )
          )
        } else if (chunk.startsWith('[DONE]')) {
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsg.id ? { ...m, streaming: false } : m
            )
          )
          // Refresh sessions list to update titles/counts
          chatApi.listSessions().then(setSessions).catch(() => {})
        } else if (!escalated) {
          fullContent += chunk
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsg.id
                ? { ...m, content: fullContent }
                : m
            )
          )
        }
      }
    } catch (err: any) {
      toast.error(err.message ?? 'Something went wrong')
      setMessages(prev => prev.filter(m => m.id !== assistantMsg.id))
    } finally {
      setStreaming(false)
    }
  }, [input, streaming, activeSession])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside
        className={clsx(
          'flex flex-col bg-gray-900 transition-all duration-200 flex-shrink-0',
          sidebarOpen ? 'w-64' : 'w-0 overflow-hidden'
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-4 border-b border-gray-800">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <span className="text-white font-semibold text-sm truncate">AI Support</span>
        </div>

        {/* New chat button */}
        <div className="p-3">
          <button onClick={newSession} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 rounded-lg transition-colors">
            <Plus className="w-4 h-4" />
            New conversation
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-3 space-y-1">
          {sessions.length === 0 && (
            <p className="text-xs text-gray-500 px-3 py-2">No conversations yet</p>
          )}
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => loadSession(s)}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate',
                activeSession?.id === s.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              )}
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{s.title ?? 'New conversation'}</span>
              </div>
              <div className="text-xs text-gray-600 mt-0.5 pl-5">
                {s.message_count} messages
              </div>
            </button>
          ))}
        </div>

        {/* Bottom user area */}
        <div className="border-t border-gray-800 p-3 space-y-1">
          {isAdmin && (
            <button
              onClick={() => navigate('/admin')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded-lg transition-colors"
            >
              <Settings className="w-4 h-4" />
              Admin dashboard
            </button>
          )}
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="w-6 h-6 bg-brand-600 rounded-full flex items-center justify-center flex-shrink-0">
              <User className="w-3 h-3 text-white" />
            </div>
            <span className="text-xs text-gray-400 truncate flex-1">{user?.full_name}</span>
            <button
              onClick={handleLogout}
              className="text-gray-600 hover:text-gray-300 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="text-gray-500 hover:text-gray-700 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div>
            <h1 className="text-sm font-semibold text-gray-900">
              {activeSession?.title ?? 'New conversation'}
            </h1>
            <p className="text-xs text-gray-500">AI-powered support assistant</p>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="w-14 h-14 bg-brand-100 rounded-2xl flex items-center justify-center mb-4">
                <Bot className="w-7 h-7 text-brand-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">How can I help you?</h2>
              <p className="text-sm text-gray-500 max-w-sm">
                Ask me anything about our products or services. I'll search our knowledge base and give you an accurate answer.
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {messages.map(msg => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              {streaming && messages[messages.length - 1]?.role === 'assistant' &&
               !messages[messages.length - 1]?.content && (
                <TypingIndicator />
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="bg-white border-t border-gray-200 px-4 py-4">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-3 bg-gray-50 border border-gray-300 rounded-xl px-4 py-3 focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 transition-all">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={e => {
                  setInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question... (Enter to send, Shift+Enter for new line)"
                disabled={streaming}
                className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 resize-none outline-none leading-relaxed disabled:opacity-50"
                style={{ minHeight: '24px', maxHeight: '160px' }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || streaming}
                className={clsx(
                  'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
                  input.trim() && !streaming
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                )}
              >
                {streaming
                  ? <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  : <Send className="w-4 h-4" />
                }
              </button>
            </div>
            <p className="text-center text-xs text-gray-400 mt-2">
              AI can make mistakes. Verify important information.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user'
  const [sourcesOpen, setSourcesOpen] = useState(false)

  return (
    <div className={clsx('flex gap-3 message-in', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div className={clsx(
        'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
        isUser ? 'bg-brand-600' : 'bg-gray-200'
      )}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-white" />
          : <Bot className="w-3.5 h-3.5 text-gray-600" />
        }
      </div>

      <div className={clsx('flex flex-col gap-1.5 max-w-[80%]', isUser && 'items-end')}>
        {/* Bubble */}
        <div className={clsx(
          'rounded-2xl px-4 py-3 text-sm leading-relaxed',
          isUser
            ? 'bg-brand-600 text-white rounded-tr-sm'
            : message.escalated
              ? 'bg-amber-50 border border-amber-200 text-amber-900 rounded-tl-sm'
              : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
        )}>
          {message.escalated && (
            <div className="flex items-center gap-1.5 mb-2 text-amber-700 text-xs font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              Connecting to human agent
            </div>
          )}
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2">
              <ReactMarkdown>{message.content}</ReactMarkdown>
              {message.streaming && !message.content && <TypingDots />}
            </div>
          )}
        </div>

        {/* Sources */}
        {message.sources && message.sources.length > 0 && (
          <div className="w-full">
            <button
              onClick={() => setSourcesOpen(v => !v)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {sourcesOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {message.sources.length} source{message.sources.length > 1 ? 's' : ''}
            </button>

            {sourcesOpen && (
              <div className="mt-1.5 space-y-1">
                {message.sources.map((src, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600"
                  >
                    <FileText className="w-3 h-3 text-gray-400 flex-shrink-0" />
                    <span className="truncate">{src.document_name}</span>
                    <span className="text-gray-400 flex-shrink-0">p.{src.page}</span>
                    <span className="ml-auto text-gray-400 flex-shrink-0">
                      {Math.round(src.score * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
        <Bot className="w-3.5 h-3.5 text-gray-600" />
      </div>
      <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
        <TypingDots />
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 h-4">
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
    </div>
  )
}
