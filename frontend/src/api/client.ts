const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const API = `${BASE_URL}/api/v1`

// ── Token storage ─────────────────────────────────────────────

export const tokenStorage = {
  getAccess: () => localStorage.getItem('access_token'),
  getRefresh: () => localStorage.getItem('refresh_token'),
  set: (access: string, refresh: string) => {
    localStorage.setItem('access_token', access)
    localStorage.setItem('refresh_token', refresh)
  },
  clear: () => {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
  },
}

// ── Types ─────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface User {
  id: string
  email: string
  full_name: string
  role: 'user' | 'admin'
}

export interface Session {
  id: string
  title: string | null
  created_at: string
  message_count: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface Document {
  id: string
  original_name: string
  file_type: string
  file_size: number
  chunk_count: number
  is_indexed: boolean
  created_at: string
}

export interface Analytics {
  total_queries: number
  answered_queries: number
  escalated_queries: number
  resolution_rate: number
  avg_response_time_ms: number
  queries_today: number
  queries_this_week: number
  queries_this_month: number
  top_queries: { query: string; count: number }[]
  daily_volume: { date: string; queries: number }[]
}

// ── Core fetch wrapper ────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const token = tokenStorage.getAccess()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (options.body instanceof FormData) delete headers['Content-Type']

  const res = await fetch(`${API}${path}`, { ...options, headers })

  if (res.status === 401 && retry) {
    const refreshed = await attemptTokenRefresh()
    if (refreshed) return apiFetch<T>(path, options, false)
    tokenStorage.clear()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(err.detail ?? 'Request failed')
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

async function attemptTokenRefresh(): Promise<boolean> {
  const refresh = tokenStorage.getRefresh()
  if (!refresh) return false
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    })
    if (!res.ok) return false
    const data: TokenResponse = await res.json()
    tokenStorage.set(data.access_token, data.refresh_token)
    return true
  } catch {
    return false
  }
}

// ── Auth ──────────────────────────────────────────────────────

export const authApi = {
  register: (email: string, full_name: string, password: string) =>
    apiFetch<TokenResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, full_name, password }),
    }),

  login: (email: string, password: string) =>
    apiFetch<TokenResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => {
    const refresh = tokenStorage.getRefresh()
    if (refresh) {
      apiFetch('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refresh }),
      }).catch(() => {})
    }
    tokenStorage.clear()
  },

  me: () => apiFetch<User>('/auth/me'),
}

// ── Chat ──────────────────────────────────────────────────────

export const chatApi = {
  createSession: () =>
    apiFetch<Session>('/chat/sessions', { method: 'POST' }),

  listSessions: () =>
    apiFetch<Session[]>('/chat/sessions'),

  getMessages: (sessionId: string) =>
    apiFetch<Message[]>(`/chat/sessions/${sessionId}/messages`),

  streamChat: (message: string, sessionId?: string): EventSource => {
    // Use fetch for streaming to include auth header
    return { message, sessionId } as unknown as EventSource
  },

  streamChatFetch: async function* (
    message: string,
    sessionId?: string
  ): AsyncGenerator<string> {
    const token = tokenStorage.getAccess()
    const res = await fetch(`${API}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message, session_id: sessionId ?? null }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Stream failed' }))
      throw new Error(err.detail)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          yield line.slice(6)
        }
      }
    }
  },
}

// ── Admin ─────────────────────────────────────────────────────

export const adminApi = {
  uploadDocument: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch<Document>('/admin/documents', {
      method: 'POST',
      body: form,
    })
  },

  listDocuments: () => apiFetch<Document[]>('/admin/documents'),

  deleteDocument: (id: string) =>
    apiFetch<void>(`/admin/documents/${id}`, { method: 'DELETE' }),

  getAnalytics: () => apiFetch<Analytics>('/admin/analytics'),
}
