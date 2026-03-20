const API_BASE = '/api/v1'

// ── Token storage ─────────────────────────────────────────────

export const tokenStorage = {
  getAccess: (): string | null => localStorage.getItem('access_token'),
  getRefresh: (): string | null => localStorage.getItem('refresh_token'),
  set: (access: string, refresh: string): void => {
    localStorage.setItem('access_token', access)
    localStorage.setItem('refresh_token', refresh)
  },
  clear: (): void => {
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

// ── Core fetch ────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retried = false
): Promise<T> {
  const token = tokenStorage.getAccess()
  const isFormData = options.body instanceof FormData

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string> | undefined),
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })

  if (res.status === 401 && !retried) {
    const ok = await tryRefresh()
    if (ok) return apiFetch<T>(path, options, true)
    tokenStorage.clear()
    window.location.href = '/login'
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(body.detail ?? 'Request failed')
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function tryRefresh(): Promise<boolean> {
  const refresh = tokenStorage.getRefresh()
  if (!refresh) return false
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
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

// ── Auth API ──────────────────────────────────────────────────

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
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      }).catch(() => {})
    }
    tokenStorage.clear()
  },

  me: () => apiFetch<User>('/auth/me'),
}

// ── Chat API ──────────────────────────────────────────────────

export const chatApi = {
  createSession: () =>
    apiFetch<Session>('/chat/sessions', { method: 'POST' }),

  listSessions: () =>
    apiFetch<Session[]>('/chat/sessions'),

  getMessages: (sessionId: string) =>
    apiFetch<Message[]>(`/chat/sessions/${sessionId}/messages`),

  async *streamChat(
    message: string,
    sessionId?: string
  ): AsyncGenerator<string, void, unknown> {
    const token = tokenStorage.getAccess()
    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message,
        session_id: sessionId ?? null,
      }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: 'Stream failed' }))
      throw new Error(body.detail ?? 'Stream failed')
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

// ── Admin API ─────────────────────────────────────────────────

export const adminApi = {
  uploadDocument: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch<Document>('/admin/documents', {
      method: 'POST',
      body: form,
    })
  },

  listDocuments: () =>
    apiFetch<Document[]>('/admin/documents'),

  deleteDocument: (id: string) =>
    apiFetch<void>(`/admin/documents/${id}`, { method: 'DELETE' }),

  getAnalytics: () =>
    apiFetch<Analytics>('/admin/analytics'),
}
