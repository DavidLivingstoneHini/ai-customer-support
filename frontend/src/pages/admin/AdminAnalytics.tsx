import { useEffect, useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Activity, CheckCircle, Clock, TrendingUp, Users, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { adminApi, type Analytics } from '../../api/client'

const COLORS = ['#2563eb', '#f59e0b', '#ef4444']

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string
  value: string | number
  sub?: string
  icon: React.ElementType
  color: string
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

export default function AdminAnalytics() {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.getAnalytics()
      .then(setData)
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!data) return null

  const resolutionData = [
    { name: 'Answered', value: data.answered_queries },
    { name: 'Escalated', value: data.escalated_queries },
    { name: 'Failed', value: data.total_queries - data.answered_queries - data.escalated_queries },
  ]

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500">System performance overview</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total queries"
          value={data.total_queries.toLocaleString()}
          sub={`${data.queries_today} today`}
          icon={Activity}
          color="bg-blue-100 text-blue-600"
        />
        <StatCard
          label="Resolution rate"
          value={`${data.resolution_rate}%`}
          sub={`${data.answered_queries} answered`}
          icon={CheckCircle}
          color="bg-green-100 text-green-600"
        />
        <StatCard
          label="Avg response time"
          value={`${(data.avg_response_time_ms / 1000).toFixed(1)}s`}
          sub="Per query"
          icon={Clock}
          color="bg-purple-100 text-purple-600"
        />
        <StatCard
          label="Escalations"
          value={data.escalated_queries.toLocaleString()}
          sub={`${data.queries_this_week} this week`}
          icon={AlertTriangle}
          color="bg-amber-100 text-amber-600"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Query volume */}
        <div className="card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Query volume (last 14 days)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data.daily_volume} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorQ" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563eb" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Area
                type="monotone"
                dataKey="queries"
                stroke="#2563eb"
                strokeWidth={2}
                fill="url(#colorQ)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Resolution pie */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Resolution breakdown</h2>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={resolutionData}
                cx="50%"
                cy="45%"
                innerRadius={55}
                outerRadius={80}
                paddingAngle={3}
                dataKey="value"
              >
                {resolutionData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 12 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top queries */}
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Top queries</h2>
        {data.top_queries.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">No queries yet</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={data.top_queries.slice(0, 8)}
              layout="vertical"
              margin={{ top: 0, right: 20, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="query"
                width={200}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => v.length > 32 ? v.slice(0, 32) + '…' : v}
              />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="count" fill="#2563eb" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
