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

// Entry icons: one plain 20px glyph per kind of entry, in the same strokes as the
// buttons above, for the shortcut pad and the lines of the latest entries.

function glyph(paths, { fill = false } = {}) {
  return () =>
    html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d=${paths}
        fill=${fill ? 'currentColor' : 'none'}
        fill-opacity=${fill ? '0.2' : undefined}
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>`;
}

export const PlusIcon = glyph('M10 4v12M4 10h12');
export const SailIcon = glyph('M10 2.5V14M10 3.5 16 13H10M9 6 4.5 13H9M3 16h14l-2 2H5z', {
  fill: true
});
export const EngineIcon = glyph('M3 8h2V6h4v2h3l2 2h3v5H5v-2H3zM8 4h4M6 15v2M14 15v2');
export const TurnIcon = glyph('M14 16V8a4 4 0 0 0-8 0v3M3.5 9 6 12l2.5-3');
export const GybeIcon = glyph('M6 16V8a4 4 0 0 1 8 0v3M11.5 9 14 12l2.5-3');
export const ReefInIcon = glyph('M4 5l6 4 6-4M4 15l6-4 6 4');
export const ReefOutIcon = glyph('M4 9l6-4 6 4M4 11l6 4 6-4');
export const AnchorIcon = glyph(
  'M10 5.5a1.7 1.7 0 1 0 0-.01M10 7v10M6.5 10.5h7M4 12a6 6 0 0 0 12 0M3 12.5l1 -1.5M17 12.5l-1-1.5'
);
export const MoorIcon = glyph('M5 17V3M5 4h9l-2 3 2 3H5');
export const WatchIcon = glyph('M4 7h11M12 4l3 3-3 3M16 13H5M8 10l-3 3 3 3');
export const NoteIcon = glyph('M4 4h12v9l-4 4H4zM12 17v-4h4M7 8h6M7 11h3');
export const PenIcon = glyph('M13.3 2.7 17.3 6.7 7 17 2.5 17.5 3 13zM11.3 4.7l4 4');
export const AlarmIcon = glyph('M10 3 18 17H2zM10 8v4M10 14.5v.01');
export const CompassIcon = glyph(
  'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12.5 7.5 11 11l-3.5 1.5L9 9z'
);
export const WindIcon = glyph('M3 8h8a2.5 2.5 0 1 0-2.5-2.5M3 12h11a2.5 2.5 0 1 1-2.5 2.5M3 16h5');
export const CourseIcon = glyph('M10 2.5 15 16l-5-3-5 3z');
export const PlaceIcon = glyph(
  'M10 17s5-4.5 5-9a5 5 0 0 0-10 0c0 4.5 5 9 5 9zM10 9.3a1.3 1.3 0 1 0 0-.01'
);
export const CloudIcon = glyph('M6 15a3.5 3.5 0 0 1-.3-7A4.5 4.5 0 0 1 14 7a4 4 0 0 1 0 8z');
export const DotIcon = glyph('M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z');

const MANOEUVRE_ICONS = {
  tack: TurnIcon,
  gybe: GybeIcon,
  reef_in: ReefInIcon,
  reef_out: ReefOutIcon,
  sail_change: SailIcon,
  anchor_down: AnchorIcon,
  anchor_up: AnchorIcon,
  moor: MoorIcon,
  cast_off: SailIcon,
  watch_change: WatchIcon
};

// The icon of a manoeuvre shortcut; those the crew added have a plain mark.
export function manoeuvreIcon(key) {
  return MANOEUVRE_ICONS[key] ?? NoteIcon;
}

// The icon of a logged event, by its type (and the manoeuvre it names).
export function eventIcon(event) {
  switch (event.type) {
    case 'manoeuvre':
      return manoeuvreIcon(event.subtype);
    case 'text_annotation':
      return NoteIcon;
    case 'handwritten_annotation':
      return PenIcon;
    case 'sk_alarm':
      return AlarmIcon;
    case 'autopilot':
      return CompassIcon;
    case 'weather_threshold':
      return event.subtype === 'pressure_drop' ? CloudIcon : WindIcon;
    case 'heading_change':
      return CourseIcon;
    case 'propulsion_change':
    case 'manual_correction':
      return event.payload?.after?.type === 'engine' ? EngineIcon : SailIcon;
    case 'stopover':
      return PlaceIcon;
    default:
      return DotIcon;
  }
}

// The icon of an entry still waiting in the outbox, from the body to send.
export function queuedIcon(body) {
  if (body.type === 'manoeuvre') {
    return manoeuvreIcon(body.subtype);
  }
  return body.type === 'handwritten_annotation' ? PenIcon : NoteIcon;
}
