import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { BarChart3, Bot, FileText, LogOut, MessageSquare } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'

const navItems = [
  { to: '/admin/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/admin/documents', icon: FileText,  label: 'Documents' },
]

export default function AdminLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-4 border-b border-gray-800">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-white text-sm font-semibold">AI Support</p>
            <p className="text-gray-500 text-xs">Admin</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                )
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}

          <button
            onClick={() => navigate('/chat')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm
                       text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          >
            <MessageSquare className="w-4 h-4 flex-shrink-0" />
            Back to chat
          </button>
        </nav>

        {/* User */}
        <div className="border-t border-gray-800 p-3">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="w-6 h-6 bg-brand-600 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-white text-xs font-semibold">
                {user?.full_name?.[0]?.toUpperCase() ?? '?'}
              </span>
            </div>
            <span className="text-xs text-gray-400 truncate flex-1 min-w-0">
              {user?.full_name}
            </span>
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

      {/* Page content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
