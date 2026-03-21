import uuid
from pathlib import Path

import structlog
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import (
    PyPDFLoader,
    Docx2txtLoader,
    TextLoader,
)
from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from app.config import settings
from app.rag.pinecone_client import get_pinecone_index

logger = structlog.get_logger()
openai_client = AsyncOpenAI(api_key=settings.openai_api_key)

SUPPORTED_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
}


def load_document(file_path: str, file_type: str) -> list:
    if file_type == "pdf":
        loader = PyPDFLoader(file_path)
    elif file_type == "docx":
        loader = Docx2txtLoader(file_path)
    else:
        loader = TextLoader(file_path, encoding="utf-8")
    return loader.load()


def chunk_documents(docs: list, doc_id: str, original_name: str) -> list[dict]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        length_function=len,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks = splitter.split_documents(docs)
    return [
        {
            "id": f"{doc_id}#{i}",
            "text": chunk.page_content.strip(),
            "metadata": {
                "document_id": doc_id,
                "document_name": original_name,
                "chunk_index": i,
                "page": chunk.metadata.get("page", 0),
            },
        }
        for i, chunk in enumerate(chunks)
        if chunk.page_content.strip()
    ]


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=10))
async def embed_texts(texts: list[str]) -> list[list[float]]:
    response = await openai_client.embeddings.create(
        model=settings.openai_embedding_model,
        input=texts,
        dimensions=settings.openai_embedding_dimensions,
    )
    return [item.embedding for item in response.data]


async def ingest_document(
    file_path: Path, doc_id: str, original_name: str, file_type: str
) -> int:
    logger.info("Ingestion started", doc_id=doc_id, filename=original_name)

    docs = load_document(str(file_path), file_type)
    chunks = chunk_documents(docs, doc_id, original_name)

    if not chunks:
        logger.warning("No chunks extracted", doc_id=doc_id)
        return 0

    index = get_pinecone_index()
    batch_size = 100

    for batch_start in range(0, len(chunks), batch_size):
        batch = chunks[batch_start : batch_start + batch_size]
        texts = [c["text"] for c in batch]
        embeddings = await embed_texts(texts)

        vectors = [
            {
                "id": chunk["id"],
                "values": embedding,
                "metadata": {**chunk["metadata"], "text": chunk["text"]},
            }
            for chunk, embedding in zip(batch, embeddings)
        ]
        index.upsert(vectors=vectors)

    logger.info("Ingestion complete", doc_id=doc_id, total_chunks=len(chunks))
    return len(chunks)


async def delete_document_vectors(doc_id: str) -> None:
    index = get_pinecone_index()
    index.delete(filter={"document_id": {"$eq": doc_id}})
    logger.info("Vectors deleted", doc_id=doc_id)


async def embed_query(query: str) -> list[float]:
    response = await openai_client.embeddings.create(
        model=settings.openai_embedding_model,
        input=[query],
        dimensions=settings.openai_embedding_dimensions,
    )
    return response.data[0].embedding


async def retrieve_context(query: str) -> list[dict]:
    query_embedding = await embed_query(query)
    index = get_pinecone_index()

    results = index.query(
        vector=query_embedding,
        top_k=settings.top_k_results,
        include_metadata=True,
    )

    return [
        {
            "text": match.metadata.get("text", ""),
            "document_name": match.metadata.get("document_name", "Unknown"),
            "document_id": match.metadata.get("document_id", ""),
            "chunk_index": match.metadata.get("chunk_index", 0),
            "page": match.metadata.get("page", 0),
            "score": match.score,
        }
        for match in results.matches
    ]
