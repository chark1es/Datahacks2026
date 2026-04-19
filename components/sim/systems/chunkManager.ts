import { CHUNK_LENGTH, VISIBLE_CHUNKS } from "@/components/sim/constants";

export type ChunkManager<T> = {
  loadedChunks: Map<number, T>;
  syncChunks: (carZ: number) => void;
  dispose: () => void;
};

type ChunkManagerOptions<T> = {
  makeChunk: (chunkIndex: number) => T;
  removeChunk: (chunk: T) => void;
  chunkLength?: number;
  visibleChunks?: number;
};

export function createChunkManager<T>({
  makeChunk,
  removeChunk,
  chunkLength = CHUNK_LENGTH,
  visibleChunks = VISIBLE_CHUNKS,
}: ChunkManagerOptions<T>): ChunkManager<T> {
  const loadedChunks = new Map<number, T>();

  const syncChunks = (carZ: number) => {
    const currentChunk = Math.floor(carZ / chunkLength);
    const start = currentChunk - 2;
    const end = start + visibleChunks - 1;

    for (let i = start; i <= end; i++) {
      if (!loadedChunks.has(i)) {
        loadedChunks.set(i, makeChunk(i));
      }
    }

    for (const [index, chunk] of loadedChunks) {
      if (index < start || index > end) {
        removeChunk(chunk);
        loadedChunks.delete(index);
      }
    }
  };

  const dispose = () => {
    for (const chunk of loadedChunks.values()) {
      removeChunk(chunk);
    }
    loadedChunks.clear();
  };

  return { loadedChunks, syncChunks, dispose };
}
