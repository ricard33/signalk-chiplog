import { html } from '../../../vendor/preact-htm.mjs';

// Small line icons for the recent-entries actions: plain strokes in
// `currentColor` so they follow the button's text colour (including `.danger`)
// and both themes with no extra styling.

export function PencilIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M13.3 2.7 17.3 6.7 7 17 2.5 17.5 3 13 Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <path d="M11.3 4.7 15.3 8.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>`;
}

export function FinePenIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M13.3 2.7 17.3 6.7 7 17 2.5 17.5 3 13 Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <path d="M11.3 4.7 15.3 8.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
  </svg>`;
}

export function ThickPenIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M13.3 2.7 17.3 6.7 7 17 2.5 17.5 3 13 Z"
      fill="currentColor"
      fill-opacity="0.2"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <path d="M11.3 4.7 15.3 8.7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
  </svg>`;
}

export function HighlighterIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M6 12.5 12.5 6l3 3-6.5 6.5z"
      fill="currentColor"
      fill-opacity="0.35"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linejoin="round"
    />
    <path
      d="M6 12.5 3.5 17l4.5-2.5z"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linejoin="round"
    />
  </svg>`;
}

export function EraserIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <g transform="rotate(-25 10 10)">
      <rect
        x="4"
        y="6"
        width="12"
        height="8"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <line x1="4" y1="10.5" x2="16" y2="10.5" stroke="currentColor" stroke-width="1.6" />
    </g>
  </svg>`;
}

export function UndoIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M5 8H12a4 4 0 0 1 0 8H8"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M8 4.5 4.5 8 8 11.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>`;
}

export function TrashIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M4 6h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    <path
      d="M7.5 6V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M5.5 6l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M8.3 8.5v6M10 8.5v6M11.7 8.5v6"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>`;
}

export function CheckIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M4 10.5 8 14.5 16 5.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>`;
}

export function ClockIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8" />
    <path
      d="M10 5.8V10l2.8 1.8"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>`;
}

export function CloseIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>`;
}
