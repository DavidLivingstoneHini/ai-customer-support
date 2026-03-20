from functools import lru_cache

from pinecone import Pinecone, ServerlessSpec

from app.config import settings


@lru_cache
def get_pinecone_index():
    pc = Pinecone(api_key=settings.pinecone_api_key)

    existing = [i.name for i in pc.list_indexes()]
    if settings.pinecone_index_name not in existing:
        pc.create_index(
            name=settings.pinecone_index_name,
            dimension=settings.openai_embedding_dimensions,
            metric="cosine",
            spec=ServerlessSpec(cloud="aws", region="us-east-1"),
        )

    return pc.Index(settings.pinecone_index_name)
