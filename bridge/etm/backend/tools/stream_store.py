"""Replay JSONL without materializing a trace. File names are fixed, never user paths."""
import json
from pathlib import Path


class JsonLines:
    def __init__(self, path, count):
        self.path, self.count = Path(path), int(count) if count is not None else None

    def __len__(self):
        if self.count is None:raise TypeError("JSONL count not provided")
        return self.count

    def __iter__(self):
        count=0
        with self.path.open(encoding='utf-8') as stream:
            for line in stream:
                if line.strip():
                    count+=1
                    yield json.loads(line)
        if self.count is not None and count!=self.count:
            raise ValueError(f"JSONL记录数不一致：{self.path.name}，预期{self.count}，实际{count}；请重新解码")


def attach_streams(result, folder):
    meta = result.get('streamed', {})
    if meta.get('schema') != 2:
        return result
    folder = Path(folder)
    for key in ('events', 'packets', 'elements'):
        result[key] = JsonLines(folder / (key + '.jsonl'), meta[key])
    result['sources'] = json.loads((folder / 'sources.json').read_text(encoding='utf-8'))
    return result
