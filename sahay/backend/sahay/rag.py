"""RAG over the trusted knowledge base in backend/knowledge_base/*.md.

Each file starts with front matter-ish lines `title:` and `source:`; the body is split
into one chunk per `## ` section so citations point at a specific section.
"""

import os
from pathlib import Path

from langchain.embeddings import init_embeddings
from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore

KB_DIR = Path(__file__).parent.parent / "knowledge_base"
MIN_SCORE = float(os.getenv("SAHAY_MIN_SCORE", "0.58"))  # cosine similarity; below this a chunk is treated as irrelevant


def load_chunks() -> list[Document]:
    docs = []
    for path in sorted(KB_DIR.glob("*.md")):
        head, _, body = path.read_text().partition("\n---\n")
        meta = dict(line.split(": ", 1) for line in head.strip().splitlines())
        for i, section in enumerate(body.split("\n## ")):
            section = section.strip().removeprefix("## ")
            if not section:
                continue
            heading = section.splitlines()[0].lstrip("# ")
            docs.append(Document(
                page_content=f"{meta['title']} — {section}",
                metadata={"id": f"{path.stem}#{i}", "title": meta["title"], "section": heading, "source": meta.get("source", path.name)},
            ))
    return docs


# ponytail: in-memory index rebuilt at startup, fine for a few dozen documents; swap for Chroma/pgvector if the KB grows.
_store: InMemoryVectorStore | None = None


def store() -> InMemoryVectorStore:
    global _store
    if _store is None:
        _store = InMemoryVectorStore(init_embeddings(os.getenv("SAHAY_EMBEDDINGS", "google_genai:gemini-embedding-001")))
        _store.add_documents(load_chunks())
    return _store


def retrieve(query: str, k: int = 5) -> list[dict]:
    hits = store().similarity_search_with_score(query, k=k)
    return [{**doc.metadata, "content": doc.page_content, "score": round(score, 3)} for doc, score in hits if score >= MIN_SCORE]
