// Leaflet's canvas renderer can run a queued redraw just after its map was removed (switching views quickly), which throws
// "Cannot read properties of undefined (reading 'clearRect')". Skip a redraw when the canvas is already gone.
import L from 'leaflet';
if (!L.Canvas.prototype.__safeRedraw) {
  const redraw = L.Canvas.prototype._redraw;
  L.Canvas.prototype._redraw = function safeRedraw() { if (!this._ctx) return undefined; return redraw.call(this); };
  L.Canvas.prototype.__safeRedraw = true;
}
