// Asset access on top of the PAK: palette, 2D pictures (lmp + WAD), fonts.
import { Pak, Wad, parsePic, picToRGBA, Pic } from './pak';

export class Assets {
  palette: Uint8Array;
  colormap: Uint8Array;
  wad: Wad | null = null;
  private canvases = new Map<string, HTMLCanvasElement | null>();
  private pics = new Map<string, Pic | null>();
  conchars: HTMLCanvasElement | null = null;

  constructor(public pak: Pak) {
    const pal = pak.get('gfx/palette.lmp');
    if (!pal) throw new Error('gfx/palette.lmp not found — is this the Quake PAK?');
    this.palette = pal.slice();
    this.colormap = pak.get('gfx/colormap.lmp')?.slice() ?? new Uint8Array(16384);
    const w = pak.get('gfx.wad');
    if (w) this.wad = new Wad(w);
    this.buildConchars();
  }

  validate() {
    const need = ['progs.dat', 'maps/start.bsp', 'maps/e1m1.bsp'];
    return need.filter((n) => !this.pak.has(n));
  }

  pic(name: string): Pic | null {
    if (this.pics.has(name)) return this.pics.get(name)!;
    let p: Pic | null = null;
    if (name.startsWith('gfx/') && name.endsWith('.lmp')) {
      const d = this.pak.get(name);
      if (d) p = parsePic(d);
    } else {
      const d = this.wad?.get(name);
      if (d) p = parsePic(d);
    }
    this.pics.set(name, p);
    return p;
  }

  /** Get a drawable canvas for a "gfx/x.lmp" path or a gfx.wad lump name. */
  canvas(name: string): HTMLCanvasElement | null {
    if (this.canvases.has(name)) return this.canvases.get(name)!;
    const p = this.pic(name);
    let c: HTMLCanvasElement | null = null;
    if (p && p.width > 0 && p.height > 0 && p.width < 2048) {
      c = document.createElement('canvas');
      c.width = p.width;
      c.height = p.height;
      const rgba = picToRGBA(p, this.palette, true);
      c.getContext('2d')!.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
    }
    this.canvases.set(name, c);
    return c;
  }

  private buildConchars() {
    const d = this.wad?.get('conchars');
    if (!d || d.length < 128 * 128) return;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const rgba = new Uint8ClampedArray(128 * 128 * 4);
    for (let i = 0; i < 128 * 128; i++) {
      const ci = d[i];
      rgba[i * 4] = this.palette[ci * 3];
      rgba[i * 4 + 1] = this.palette[ci * 3 + 1];
      rgba[i * 4 + 2] = this.palette[ci * 3 + 2];
      rgba[i * 4 + 3] = ci === 0 ? 0 : 255;
    }
    c.getContext('2d')!.putImageData(new ImageData(rgba, 128, 128), 0, 0);
    this.conchars = c;
  }

  bsp(map: string) {
    return this.pak.getBuffer('maps/' + map + '.bsp');
  }
}
