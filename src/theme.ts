/**
 * Paleta compartida entre la aplicación y las pantallas de acceso.
 *
 * Estaba definida dentro de App.tsx; se extrajo aquí para que la pantalla de
 * login pueda usar los mismos colores sin importar el módulo entero.
 */

export const C = {
  gold: '#c9a84c', goldL: '#e8c96a', goldD: '#a0732e',
  bg: '#07070e', surf: '#0a0a14', surf2: '#0d0d1c', surf3: '#111120',
  border: '#161626', border2: '#1e1e30',
  text: '#d8d8f0', muted: '#404060', faint: '#252540',
  green: '#2a9d6e', red: '#e05252', blue: '#5b9cf6', purple: '#9b6cf6',
};

export const PIE_PAL = [C.gold, C.blue, C.green, C.purple, '#e8734a', '#1abc9c', '#e74c3c', '#3498db'];
