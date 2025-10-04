/*!
 * nodeplot – tiny canvas line plotting helper
 * API:
 *   nodeplot.lineChart(canvasEl, Map<label, [{x:Date,y:Number}]>, { yLabel })
 *   nodeplot.clear(canvasEl)
 */
(function (global) {
  const nodeplot = {};

  // Palette (auto)
  const COLORS = [
    "#2563eb", "#16a34a", "#dc2626", "#9333ea", "#f59e0b",
    "#06b6d4", "#ef4444", "#10b981", "#8b5cf6", "#f97316",
    "#22c55e", "#3b82f6", "#eab308", "#ea580c", "#14b8a6"
  ];

  function dprScale(ctx, canvas, width, height){
    const dpr = global.devicePixelRatio || 1;
    canvas.width  = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width  = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function bounds(seriesMap){
    let xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity, any=false;
    for (const arr of seriesMap.values()){
      for (const p of arr){
        if (!(p.x instanceof Date) || isNaN(+p.x) || typeof p.y!=="number" || !isFinite(p.y)) continue;
        any=true;
        const t=+p.x;
        if (t<xMin) xMin=t;
        if (t>xMax) xMax=t;
        if (p.y<yMin) yMin=p.y;
        if (p.y>yMax) yMax=p.y;
      }
    }
    if (!any) return null;
    if (xMin===xMax) { xMin-=1; xMax+=1; }
    if (yMin===yMax) { yMin-=1; yMax+=1; }
    return { xMin,xMax,yMin,yMax };
  }

  function niceTicks(min, max, count){
    const span = max-min;
    if (!isFinite(span) || span<=0) return [min,max];
    const step = Math.pow(10, Math.floor(Math.log10(span/count)));
    const err  = span/(count*step);
    const mult = err>=7.5?10:err>=3.5?5:err>=1.5?2:1;
    const s = step*mult;
    const tickMin = Math.floor(min/s)*s;
    const tickMax = Math.ceil(max/s)*s;
    const ticks=[];
    for(let v=tickMin; v<=tickMax+1e-9; v+=s) ticks.push(v);
    return ticks;
  }

  function lineChart(canvas, seriesMap, opts={}){
    const ctx = canvas.getContext("2d");
    const width  = canvas.clientWidth  || 900;
    const height = canvas.clientHeight || 320;
    dprScale(ctx, canvas, width, height);

    ctx.clearRect(0,0,width,height);
    const pad = { l:70, r:15, t:10, b:28 };
    const W = width - pad.l - pad.r;
    const H = height - pad.t - pad.b;

    const b = bounds(seriesMap);
    if (!b){
      ctx.fillStyle = "#6b7280"; ctx.font = "14px ui-monospace,monospace";
      ctx.fillText("No data", pad.l, pad.t+20);
      return;
    }

    const xTicksCount = Math.max(3, Math.floor(W/140));
    const yTicksCount = 5;
    const yTicks = niceTicks(b.yMin, b.yMax, yTicksCount);

    const xScale = (t)=> pad.l + ( (t - b.xMin) / (b.xMax - b.xMin) ) * W;
    const yScale = (v)=> pad.t + H - ( (v - yTicks[0]) / (yTicks[yTicks.length-1]-yTicks[0]) ) * H;

    // Axes
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t+H);
    ctx.lineTo(pad.l+W, pad.t+H);
    ctx.stroke();

    // Y ticks + labels
    ctx.fillStyle = "#6b7280"; ctx.font = "12px ui-monospace,monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const v of yTicks){
      const y = yScale(v);
      ctx.strokeStyle = "#e5e7eb";
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l+W, y); ctx.stroke();
      ctx.fillStyle = "#6b7280";
      ctx.fillText(v.toFixed(2), pad.l-6, y);
    }

    // X ticks (time)
    const xSpan = b.xMax - b.xMin;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i=0;i<=xTicksCount;i++){
      const t = b.xMin + (i/xTicksCount)*xSpan;
      const x = xScale(t);
      ctx.strokeStyle = "#e5e7eb";
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t+H); ctx.stroke();
      const d = new Date(t);
      const lab = d.toLocaleString(undefined,{ hour12:false, year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
      ctx.fillStyle = "#6b7280";
      ctx.fillText(lab, x, pad.t+H+6);
    }

    // Lines + legend
    let idx = 0;
    for (const [name, arr] of seriesMap.entries()){
      const c = COLORS[idx++ % COLORS.length];
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const p of arr){
        if (!(p.x instanceof Date) || isNaN(+p.x) || typeof p.y!=="number" || !isFinite(p.y)) continue;
        const x = xScale(+p.x), y = yScale(p.y);
        if (!started){ ctx.moveTo(x,y); started = true; } else { ctx.lineTo(x,y); }
      }
      ctx.stroke();

      // Mini legend key (top-right)
      ctx.fillStyle = c;
      const yOff = pad.t + 4 + (idx-1)*16;
      ctx.fillRect(width - pad.r - 160, yOff, 12, 12);
      ctx.fillStyle = "#374151";
      ctx.font = "12px ui-monospace,monospace";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(name, width - pad.r - 142, yOff - 2);
    }

    // Y label
    if (opts.yLabel){
      ctx.save();
      ctx.translate(16, pad.t + H/2);
      ctx.rotate(-Math.PI/2);
      ctx.fillStyle = "#374151"; ctx.font = "12px ui-monospace,monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(opts.yLabel, 0, 0);
      ctx.restore();
    }
  }

  nodeplot.lineChart = lineChart;
  nodeplot.clear = (canvas)=>{ const ctx=canvas.getContext("2d"); ctx.clearRect(0,0,canvas.width,canvas.height); };

  // expose globally
  global.nodeplot = nodeplot;
})(window);
