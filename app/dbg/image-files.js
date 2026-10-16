/** File names in image commands are relative to the directory explicitly granted by the user. */
export function imagePath(filename){
  const path = String(filename).replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0'))
    throw new Error('镜像文件请使用所选镜像目录下的文件名或相对路径');
  const parts = [];
  for (const part of path.split('/')){
    if (!part || part === '.') continue;
    if (part === '..'){
      if (!parts.length) throw new Error('镜像文件路径超出已授权目录');
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length || path.endsWith('/')) throw new Error('请指定镜像文件名');
  return parts;
}

export class ImageFiles {
  constructor(){ this.root = null; }

  async pick(){
    if (!globalThis.showDirectoryPicker) throw new Error('镜像目录需要桌面版 Chrome / Edge，请通过 localhost 或 HTTPS 打开页面');
    const root = await globalThis.showDirectoryPicker({ id: 'debug-images', mode: 'readwrite' });
    this.root = root;
    return root.name;
  }

  async handle(filename, create = false){
    const parts = imagePath(filename);
    if (!this.root) throw new Error('请先在调试器侧栏选择“镜像目录”');
    try {
      let directory = this.root;
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
      return await directory.getFileHandle(parts.at(-1), { create });
    } catch (e){
      if (e.name === 'NotFoundError') throw new Error('镜像文件或目录不存在：' + filename, { cause: e });
      if (e.name === 'NotAllowedError') throw new Error('镜像目录权限不可用，请重新选择镜像目录', { cause: e });
      throw e;
    }
  }

  async read(filename){
    const handle = await this.handle(filename);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async openWrite(filename){
    return await (await this.handle(filename, true)).createWritable();
  }
}
