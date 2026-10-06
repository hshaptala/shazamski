class ShazamskiTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._total = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'DUMP') {
        const out = new Float32Array(this._total);
        let o = 0;
        for (const c of this._chunks) { out.set(c, o); o += c.length; }
        this.port.postMessage({ type: 'CHUNK_DUMP', total: this._total, buf: out.buffer }, [out.buffer]);
        this._chunks = [];
        this._total = 0;
      }
    };
  }
  process(inputs) {
    const inp = inputs && inputs[0];
    if (inp && inp.length) {
      const n = inp[0].length;
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < inp.length; c++) s += inp[c][i] || 0;
        mono[i] = s / inp.length;
      }
      const copy = new Float32Array(mono);
      this._chunks.push(copy);
      this._total += copy.length;
    }
    return true;
  }
}
registerProcessor('shazamski-tap', ShazamskiTap);
