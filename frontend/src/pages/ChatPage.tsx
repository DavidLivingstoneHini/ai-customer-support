import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Send,
  Settings,
  Ticket,
  Tool,
  User,
  Zap,
} from 'lucide-react'
import { chatApi, type Message, type Session } from '../api/client'
import { useAuth } from '../context/AuthContext'

// ── Types ─────────────────────────────────────────────────────

interface Source {
  document_name: string
  document_id: string
  page: number
  score: number
}

interface AgentStep {
  type: 'thinking' | 'tool_call' | 'tool_result'
  content: string
  toolName?: string
}

interface UIMessage extends Omit<Message, 'id'> {
  id: string
  sources?: Source[]
  escalated?: boolean
  streaming?: boolean
  agentSteps?: AgentStep[]
}

// ── Tool icon helper ──────────────────────────────────────────

function ToolIcon({ name }: { name: string }) {
  if (name === 'search_knowledge_base' || name === 'get_faq_answer')
    return <Search className="w-3 h-3" />
  if (name === 'create_support_ticket')
    return <Ticket className="w-3 h-3" />
  return <Tool className="w-3 h-3" />
}

// ── Agent steps panel ─────────────────────────────────────────

function AgentStepsPanel({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState(false)
  if (!steps.length) return null

  const toolCalls = steps.filter(s => s.type === 'tool_call')

  return (
    <div className="mt-2 w-full">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        <Zap className="w-3 h-3 text-purple-400" />
        <span className="text-purple-500 font-medium">Agent reasoning</span>
        {toolCalls.length > 0 && (
          <span className="text-gray-400">
            · {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''} used
          </span>
        )}
        {open ? (
          <ChevronDown className="w-3 h-3 ml-1" />
        ) : (
          <ChevronRight className="w-3 h-3 ml-1" />
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 border-l-2 border-purple-100 pl-3">
          {steps.map((step, i) => (
            <div key={i}>
              {step.type === 'thinking' && (
                <div className="text-xs text-gray-500 italic leading-relaxed">
                  💭 {step.content}
                </div>
              )}
              {step.type === 'tool_call' && (
                <div className="flex items-start gap-1.5 text-xs text-purple-700 bg-purple-50 rounded-lg px-2.5 py-1.5">
                  <ToolIcon name={step.toolName ?? ''} />
                  <span>
                    <span className="font-medium">Calling</span>{' '}
                    <code className="bg-purple-100 px-1 rounded text-purple-800 text-[11px]">
                      {step.toolName}
                    </code>
                    {step.content && (
                      <span className="text-purple-500 ml-1 truncate block max-w-xs">
                        {step.content}
                      </span>
                    )}
                  </span>
                </div>
              )}
              {step.type === 'tool_result' && (
                <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1.5 leading-relaxed">
                  <span className="font-medium text-gray-600">Result: </span>
                  {step.content}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────

export default function ChatPage() {
  const { user, logout, isAdmin } = useAuth()
  const navigate = useNavigate()

  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>()
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streamingMsgId = useRef<string | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    chatApi
      .listSessions()
      .then(setSessions)
      .catch(() => toast.error('Could not load sessions'))
  }, [])

  const loadSession = useCallback(
    async (session: Session) => {
      if (streaming) return
      setActiveSessionId(session.id)
      try {
        const msgs = await chatApi.getMessages(session.id)
        setMessages(msgs.map(m => ({ ...m })))
      } catch {
        toast.error('Could not load messages')
      }
    },
    [streaming]
  )

  const startNewChat = useCallback(() => {
    if (streaming) return
    setActiveSessionId(undefined)
    setMessages([])
    textareaRef.current?.focus()
  }, [streaming])

  const handleLogout = useCallback(() => {
    logout()
    navigate('/login')
  }, [logout, navigate])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    setInput('')
    setStreaming(true)

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    const userMsgId = crypto.randomUUID()
    const assistantMsgId = crypto.randomUUID()
    streamingMsgId.current = assistantMsgId

    setMessages(prev => [
      ...prev,
      {
        id: userMsgId,
        role: 'user',
        content: text,
        created_at: new Date().toISOString(),
      },
      {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
        streaming: true,
        agentSteps: [],
      },
    ])

    try {
      let accumulated = ''
      let sources: Source[] = []
      let escalated = false

      for await (const chunk of chatApi.streamChat(text, activeSessionId)) {

        // ── Agent reasoning step ──────────────────────────────
        if (chunk.startsWith('[THINKING]')) {
          const thinking = chunk.slice(10)
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    agentSteps: [
                      ...(m.agentSteps ?? []),
                      { type: 'thinking', content: thinking },
                    ],
                  }
                : m
            )
          )

        // ── Tool call ─────────────────────────────────────────
        } else if (chunk.startsWith('[TOOL_CALL]')) {
          try {
            const data = JSON.parse(chunk.slice(11))
            const argsPreview = Object.entries(data.args ?? {})
              .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
              .join(', ')
            setMessages(prev =>
              prev.map(m =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      agentSteps: [
                        ...(m.agentSteps ?? []),
                        {
                          type: 'tool_call',
                          toolName: data.name,
                          content: argsPreview,
                        },
                      ],
                    }
                  : m
              )
            )
          } catch {}

        // ── Tool result ───────────────────────────────────────
        } else if (chunk.startsWith('[TOOL_RESULT]')) {
          try {
            const data = JSON.parse(chunk.slice(13))
            setMessages(prev =>
              prev.map(m =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      agentSteps: [
                        ...(m.agentSteps ?? []),
                        {
                          type: 'tool_result',
                          toolName: data.name,
                          content: data.result,
                        },
                      ],
                    }
                  : m
              )
            )
          } catch {}

        // ── Sources ───────────────────────────────────────────
        } else if (chunk.startsWith('[SOURCES]')) {
          sources = JSON.parse(chunk.slice(9))
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, sources } : m
            )
          )

        // ── Escalate ──────────────────────────────────────────
        } else if (chunk === '[ESCALATE]') {
          escalated = true
          const escalateText =
            "I wasn't able to find a confident answer in our knowledge base. Connecting you to a human agent."
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: escalateText, escalated: true, streaming: false }
                : m
            )
          )

        // ── Injection detected ────────────────────────────────
        } else if (chunk === '[INJECTION_DETECTED]') {
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content:
                      'Potentially unsafe content detected in your message. Please rephrase.',
                    streaming: false,
                  }
                : m
            )
          )

        // ── Done ──────────────────────────────────────────────
        } else if (chunk.startsWith('[DONE]')) {
          chatApi
            .listSessions()
            .then(updated => {
              setSessions(updated)
              if (!activeSessionId && updated.length > 0) {
                setActiveSessionId(updated[0].id)
              }
            })
            .catch(() => {})

          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, streaming: false } : m
            )
          )

        // ── Regular text token ────────────────────────────────
        } else if (!escalated) {
          const token = chunk.replace(/<br>/g, '\n')
          accumulated += token
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, content: accumulated } : m
            )
          )
        }
      }
    } catch (err: any) {
      toast.error(err.message ?? 'Something went wrong')
      setMessages(prev => prev.filter(m => m.id !== assistantMsgId))
    } finally {
      setStreaming(false)
      streamingMsgId.current = null
    }
  }, [input, streaming, activeSessionId])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside
        className={clsx(
          'flex flex-col bg-gray-900 flex-shrink-0 transition-all duration-200 overflow-hidden',
          sidebarOpen ? 'w-64' : 'w-0'
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-gray-800 flex-shrink-0">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <span className="text-white font-semibold text-sm truncate block">
              AI Support
            </span>
            <span className="text-purple-400 text-[10px] font-medium">
              Agentic · Tool-use enabled
            </span>
          </div>
        </div>

        {/* New chat */}
        <div className="p-3 flex-shrink-0">
          <button
            onClick={startNewChat}
            disabled={streaming}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300
                       hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
          >
            <Plus className="w-4 h-4 flex-shrink-0" />
            New conversation
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-3 space-y-0.5 pb-2">
          {sessions.length === 0 && (
            <p className="text-gray-600 text-xs px-2 pt-2">No conversations yet</p>
          )}
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => loadSession(s)}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                s.id === activeSessionId
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              )}
            >
              <p className="truncate">{s.title ?? 'Conversation'}</p>
              <p className="text-xs text-gray-600 mt-0.5">
                {s.message_count} message{s.message_count !== 1 ? 's' : ''}
              </p>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 border-t border-gray-800 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 bg-brand-700 rounded-full flex items-center justify-center flex-shrink-0">
              <User className="w-3 h-3 text-white" />
            </div>
            <span className="text-gray-400 text-xs truncate flex-1 min-w-0">
              {user?.full_name}
            </span>
            {isAdmin && (
              <button
                onClick={() => navigate('/admin')}
                title="Admin"
                className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={handleLogout}
              title="Sign out"
              className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-gray-900 truncate">
              {sessions.find(s => s.id === activeSessionId)?.title ?? 'New conversation'}
            </h1>
            <p className="text-xs text-gray-500">Agentic AI support · searches knowledge base automatically</p>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {messages.map(msg => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="bg-white border-t border-gray-200 px-4 py-4 flex-shrink-0">
          <div className="max-w-3xl mx-auto">
            <div
              className={clsx(
                'flex items-end gap-3 bg-gray-50 border rounded-xl px-4 py-3 transition-all',
                streaming
                  ? 'border-gray-200'
                  : 'border-gray-300 focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500'
              )}
            >
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                disabled={streaming}
                placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
                className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400
                           resize-none outline-none leading-relaxed disabled:opacity-60"
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
                aria-label="Send message"
              >
                {streaming ? (
                  <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
            <p className="text-center text-xs text-gray-400 mt-2">
              The agent searches your knowledge base automatically before answering.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      <div className="w-14 h-14 bg-brand-100 rounded-2xl flex items-center justify-center mb-4">
        <Bot className="w-7 h-7 text-brand-600" />
      </div>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">
        How can I help you?
      </h2>
      <p className="text-sm text-gray-500 max-w-sm mb-4">
        Ask me anything. I'll search the knowledge base, check orders, and
        create support tickets automatically.
      </p>
      <div className="flex flex-wrap gap-2 justify-center max-w-sm">
        {[
          '🔍 Search knowledge base',
          '📦 Check order status',
          '🎫 Create support ticket',
          '❓ FAQ answers',
        ].map(hint => (
          <span
            key={hint}
            className="px-2.5 py-1 bg-gray-100 text-gray-600 text-xs rounded-full"
          >
            {hint}
          </span>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user'
  const [sourcesOpen, setSourcesOpen] = useState(false)

  return (
    <div className={clsx('flex gap-3 message-in', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div
        className={clsx(
          'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
          isUser ? 'bg-brand-600' : 'bg-gray-200'
        )}
      >
        {isUser ? (
          <User className="w-3.5 h-3.5 text-white" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-gray-600" />
        )}
      </div>

      <div className={clsx('flex flex-col gap-1.5 max-w-[80%]', isUser && 'items-end')}>
        {/* Bubble */}
        <div
          className={clsx(
            'rounded-2xl px-4 py-3 text-sm leading-relaxed',
            isUser
              ? 'bg-brand-600 text-white rounded-tr-sm'
              : message.escalated
              ? 'bg-amber-50 border border-amber-200 text-amber-900 rounded-tl-sm'
              : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
          )}
        >
          {message.escalated && (
            <div className="flex items-center gap-1.5 mb-2 text-amber-700 text-xs font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              Connecting to human agent
            </div>
          )}

          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-pre:my-2">
              {message.content ? (
                <ReactMarkdown>{message.content}</ReactMarkdown>
              ) : message.streaming ? (
                <TypingDots />
              ) : null}
            </div>
          )}
        </div>

        {/* Agent steps — shown below assistant bubble */}
        {!isUser && message.agentSteps && message.agentSteps.length > 0 && (
          <AgentStepsPanel steps={message.agentSteps} />
        )}

        {/* Sources */}
        {message.sources && message.sources.length > 0 && (
          <div className="w-full">
            <button
              onClick={() => setSourcesOpen(v => !v)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {sourcesOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {message.sources.length} source{message.sources.length !== 1 ? 's' : ''}
            </button>

            {sourcesOpen && (
              <div className="mt-1.5 space-y-1">
                {message.sources.map((src, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-50
                               border border-gray-200 rounded-lg text-xs text-gray-600"
                  >
                    <FileText className="w-3 h-3 text-gray-400 flex-shrink-0" />
                    <span className="truncate flex-1">{src.document_name}</span>
                    <span className="text-gray-400 flex-shrink-0">p.{src.page}</span>
                    <span className="text-gray-400 flex-shrink-0 ml-auto">
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

function TypingDots() {
  return (
    <div className="flex items-center gap-1 h-5">
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-gray-400 rounded-full" />
    </div>
  )
}
