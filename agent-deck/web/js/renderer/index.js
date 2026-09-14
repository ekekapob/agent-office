// Renderer factory (CONTRACTS §6, ADR-0004). Only 'iso2d' is implemented; a future 'three'
// (or other) kind would live beside it under web/js/renderer/ behind the same interface so
// nothing above the renderer (overlays, rooms list, cards) has to change.
import { createIso2DRenderer } from './iso2d/renderer.js';

/**
 * @param {'iso2d'} kind
 * @param {HTMLCanvasElement} canvas
 * @param {Object} theme theme JSON (CONTRACTS §7); missing/invalid keys fall back to the
 *   spaceship defaults (see iso2d/colors.js resolveColors)
 * @returns {{resize:function(number,number,number):void, setCamera:function(Object):void, render:function(Object,number):void, project:function({i:number,j:number,z?:number}):{x:number,y:number}, pick:function(number,number,Object):(string|null), portrait:function(CanvasRenderingContext2D,Object,number):void, destroy:function():void}}
 */
export function createRenderer(kind, canvas, theme) {
  if (kind === 'iso2d') return createIso2DRenderer(canvas, theme);
  throw new Error(`createRenderer: unknown renderer kind "${kind}" (only "iso2d" is implemented)`);
}
