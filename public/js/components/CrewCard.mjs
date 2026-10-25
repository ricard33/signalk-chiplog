import { html, useEffect, useState } from '../../vendor/preact-htm.mjs';
import { fetchAll } from '../api.mjs';
import { useLocale } from '../context.mjs';
import { ErrorNotice } from './common.mjs';

const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;

// Everyone who can be ticked: the passage's own crew first, in the order they
// were added, then the rest of the roster, then whoever was just typed in. A
// member the roster no longer holds (`crewMemberId` null) stays listed, since
// the passage recorded them.
function candidates(crew, roster, added) {
  const known = new Set(crew.map((member) => member.crewMemberId));
  return [
    ...crew.map((member) => ({
      key: `${member.id}`,
      crewMemberId: member.crewMemberId,
      name: member.name,
      role: member.role
    })),
    ...roster
      .filter((member) => !known.has(member.id))
      .map((member) => ({
        key: `roster-${member.id}`,
        crewMemberId: member.id,
        name: member.name,
        role: member.role
      })),
    ...added
  ];
}

function CrewEditor({ crew, busy, onSave, onCancel }) {
  const { t } = useLocale();
  const [roster, setRoster] = useState(null);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState([]);
  const [picked, setPicked] = useState(() => new Set(crew.map((member) => `${member.id}`)));
  const [name, setName] = useState('');
  const [role, setRole] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchAll('/crew')
      .then((items) => !cancelled && setRoster(items))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (key) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });

  const items = candidates(crew, roster ?? [], added);

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const existing = items.find((item) => sameName(item.name, trimmed));
    if (existing) {
      setPicked((previous) => new Set(previous).add(existing.key));
    } else {
      const key = `added-${added.length}`;
      setAdded((previous) => [
        ...previous,
        { key, crewMemberId: null, name: trimmed, role: role.trim() || null }
      ]);
      setPicked((previous) => new Set(previous).add(key));
    }
    setName('');
    setRole('');
  };

  const submit = (event) => {
    event.preventDefault();
    onSave(
      items
        .filter((item) => picked.has(item.key))
        .map((item) =>
          item.crewMemberId !== null && !item.key.startsWith('added-')
            ? { crewMemberId: item.crewMemberId }
            : { name: item.name, role: item.role }
        )
    );
  };

  // Enter in the name or role field adds that person rather than saving the card.
  const onFieldKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return html`
    <form class="crew-editor" onSubmit=${submit}>
      <${ErrorNotice} error=${error} />
      ${
        roster === null && !error
          ? html`<p class="muted">…</p>`
          : html`<ul class="crew-list">
              ${items.map(
                (item) =>
                  html`<li key=${item.key}>
                    <label class="crew-choice">
                      <input
                        type="checkbox"
                        checked=${picked.has(item.key)}
                        onChange=${() => toggle(item.key)}
                      />
                      ${item.name}${item.role ? html` <span class="crew-role">${item.role}</span>` : ''}
                    </label>
                  </li>`
              )}
            </ul>`
      }
      <div class="name-form">
        <input
          value=${name}
          maxlength="100"
          placeholder=${t('entry.crewName')}
          aria-label=${t('entry.crewName')}
          onInput=${(event) => setName(event.currentTarget.value)}
          onKeyDown=${onFieldKeyDown}
        />
        <input
          value=${role}
          maxlength="100"
          placeholder=${t('entry.crewRole')}
          aria-label=${t('entry.crewRole')}
          onInput=${(event) => setRole(event.currentTarget.value)}
          onKeyDown=${onFieldKeyDown}
        />
        <button type="button" disabled=${!name.trim()} onClick=${add}>
          ${t('entry.addCrewMember')}
        </button>
      </div>
      <div class="name-form">
        <button type="submit" disabled=${busy || (roster === null && !error)}>
          ${t('common.save')}
        </button>
        <button type="button" class="link-button" onClick=${onCancel}>${t('common.cancel')}</button>
      </div>
    </form>
  `;
}

export function CrewCard({ crew, busy, onSave }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);

  const save = (members) => {
    setEditing(false);
    onSave(members);
  };

  return html`
    <section class="card crew-card">
      <header class="card-header">
        <h2>${t('passage.crew')}</h2>
        ${
          !editing &&
          html`<button
            type="button"
            class="link-button"
            disabled=${busy}
            onClick=${() => setEditing(true)}
          >
            ${t('common.edit')}
          </button>`
        }
      </header>
      ${
        editing
          ? html`<${CrewEditor}
              crew=${crew}
              busy=${busy}
              onSave=${save}
              onCancel=${() => setEditing(false)}
            />`
          : crew.length === 0
            ? html`<p class="muted">${t('entry.noCrew')}</p>`
            : html`<ul class="crew-list">
                ${crew.map(
                  (member) =>
                    html`<li key=${member.id}>
                      ${member.name}${
                        member.role ? html` <span class="crew-role">${member.role}</span>` : ''
                      }
                    </li>`
                )}
              </ul>`
      }
    </section>
  `;
}
