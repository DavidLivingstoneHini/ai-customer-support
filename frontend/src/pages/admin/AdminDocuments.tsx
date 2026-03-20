import { useCallback, useEffect, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import toast from 'react-hot-toast'
import {
  FileText, Loader2, Trash2, Upload, CheckCircle, AlertCircle, File
} from 'lucide-react'
import clsx from 'clsx'
import { adminApi, type Document } from '../../api/client'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

const ACCEPTED_TYPES = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
}

export default function AdminDocuments() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchDocuments = useCallback(async () => {
    try {
      const docs = await adminApi.listDocuments()
      setDocuments(docs)
    } catch {
      toast.error('Failed to load documents')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDocuments() }, [fetchDocuments])

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return
    setUploading(true)

    for (const file of acceptedFiles) {
      try {
        toast.loading(`Uploading ${file.name}...`, { id: file.name })
        const doc = await adminApi.uploadDocument(file)
        setDocuments(prev => [doc, ...prev])
        toast.success(`${file.name} indexed (${doc.chunk_count} chunks)`, { id: file.name })
      } catch (err: any) {
        toast.error(err.message ?? `Failed to upload ${file.name}`, { id: file.name })
      }
    }
    setUploading(false)
  }, [])

  const handleDelete = async (doc: Document) => {
    if (!confirm(`Delete "${doc.original_name}"? This will remove it from the knowledge base.`)) return
    setDeletingId(doc.id)
    try {
      await adminApi.deleteDocument(doc.id)
      setDocuments(prev => prev.filter(d => d.id !== doc.id))
      toast.success('Document removed')
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to delete document')
    } finally {
      setDeletingId(null)
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxSize: 50 * 1024 * 1024,
    multiple: true,
    onDropRejected: rejections => {
      rejections.forEach(r => {
        const reason = r.errors[0]?.message ?? 'Invalid file'
        toast.error(`${r.file.name}: ${reason}`)
      })
    },
  })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Knowledge Base</h1>
        <p className="text-sm text-gray-500">
          Upload documents to train the AI. Supported formats: PDF, DOCX, TXT (max 50MB)
        </p>
      </div>

      {/* Dropzone */}
      <div
        {...getRootProps()}
        className={clsx(
          'border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors',
          isDragActive
            ? 'border-brand-500 bg-brand-50'
            : 'border-gray-300 bg-white hover:border-brand-400 hover:bg-gray-50'
        )}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center gap-3">
          <div className={clsx(
            'w-12 h-12 rounded-xl flex items-center justify-center transition-colors',
            isDragActive ? 'bg-brand-100' : 'bg-gray-100'
          )}>
            {uploading
              ? <Loader2 className="w-6 h-6 text-brand-600 animate-spin" />
              : <Upload className={clsx('w-6 h-6', isDragActive ? 'text-brand-600' : 'text-gray-500')} />
            }
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700">
              {isDragActive ? 'Drop files here' : 'Drag & drop files, or click to browse'}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">PDF, DOCX, TXT up to 50MB each</p>
          </div>
        </div>
      </div>

      {/* Document list */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">
            Indexed documents
            <span className="ml-2 text-xs font-normal text-gray-400">
              ({documents.length})
            </span>
          </h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <File className="w-8 h-8 text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-500">No documents yet</p>
            <p className="text-xs text-gray-400">Upload your first document to get started</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {documents.map(doc => (
              <div key={doc.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors">
                <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-blue-600" />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{doc.original_name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatBytes(doc.file_size)} · {doc.chunk_count} chunks · {formatDate(doc.created_at)}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {doc.is_indexed ? (
                    <div className="flex items-center gap-1 text-xs text-green-600 font-medium">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Indexed
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-xs text-amber-600 font-medium">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Processing
                    </div>
                  )}

                  <button
                    onClick={() => handleDelete(doc)}
                    disabled={deletingId === doc.id}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                    title="Delete document"
                  >
                    {deletingId === doc.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Trash2 className="w-4 h-4" />
                    }
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
