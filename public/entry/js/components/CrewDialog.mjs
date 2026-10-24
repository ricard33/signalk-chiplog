import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { PencilIcon, TrashIcon } from './Icons.mjs';
import { confirmAction } from '../confirm.mjs';

// .big-button is a row flex container, so a bare <br/> between its children
// would not stack them -- wrap name and role in their own column instead.
function CrewButtonLabel({ name, role }) {
  return html`<span class="crew-button-label"
    >${name}${role ? html`<span class="crew-role">${role}</span>` : ''}</span
  >`;
}

// roster: the global crew list ({id, name, role}); current: this passage's
// crew as GET /entries/:id returns it ({id, crewMemberId, name, role}).
// onAddMember(name, role) creates a roster member (POST /crew) and picks it;
// onEditMember(id, {name, role}) and onDeleteMember(id) correct or remove one
// (PATCH/DELETE /crew/:id) -- both act on the roster itself, not just this
// passage's assignment, which is only sent to the server on Enregistrer.
export function CrewDialog({
  roster,
  current,
  onCancel,
  onSave,
  onAddMember,
  onEditMember,
  onDeleteMember
}) {
  const { t } = useLocale();
  const [picked, setPicked] = useState(
    () => new Set((current ?? []).filter((m) => m.crewMemberId !== null).map((m) => m.crewMemberId))
  );
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [editingId, setEditingId] = useState(null);

  const toggle = (id) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const startEditing = (member) => {
    setEditingId(member.id);
    setName(member.name);
    setRole(member.role ?? '');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setName('');
    setRole('');
  };

  const addNew = async (event) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    const member = await onAddMember(trimmedName, role.trim() || null);
    if (member) {
      setPicked((prev) => new Set(prev).add(member.id));
      setName('');
      setRole('');
    }
  };

  const saveEdit = (event) => {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }
    onEditMember(editingId, { name: name.trim(), role: role.trim() || null });
    setEditingId(null);
    setName('');
    setRole('');
  };

  const removeMember = async (member) => {
    if (!(await confirmAction(t('entry.deleteCrewMemberConfirm', { name: member.name }), t))) {
      return;
    }
    const removed = await onDeleteMember(member.id);
    if (!removed) {
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      next.delete(member.id);
      return next;
    });
    if (editingId === member.id) {
      cancelEditing();
    }
  };

  // The name/role fields sit inside the dialog's own <form>, so Enter would
  // otherwise submit that -- saving and closing the whole dialog -- instead
  // of adding or saving this one member.
  const onFieldKeyDown = (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    (editingId === null ? addNew : saveEdit)(event);
  };

  const submit = (event) => {
    event.preventDefault();
    onSave([...picked].map((crewMemberId) => ({ crewMemberId })));
  };

  const editingMember = roster.find((member) => member.id === editingId) ?? null;

  return html`
    <div class="sheet-backdrop" onClick=${(event) => event.target === event.currentTarget && onCancel()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="crew-title" onSubmit=${submit}>
        <h2 id="crew-title">${t('entry.editCrew')}</h2>
        <div class="crew-grid">
          ${roster.map(
            (member) =>
              html`<div class="crew-item" key=${member.id}>
                <button
                  type="button"
                  class=${picked.has(member.id) ? 'big-button primary' : 'big-button'}
                  onClick=${() => toggle(member.id)}
                >
                  <${CrewButtonLabel} name=${member.name} role=${member.role} />
                </button>
                <div class="crew-item-actions">
                  <button
                    type="button"
                    class="tool-button icon-button"
                    aria-label=${t('entry.editCrewMember', { name: member.name })}
                    title=${t('common.edit')}
                    onClick=${() => startEditing(member)}
                  >
                    <${PencilIcon} />
                  </button>
                  <button
                    type="button"
                    class="tool-button icon-button danger"
                    aria-label=${t('entry.deleteCrewMember', { name: member.name })}
                    title=${t('entry.delete')}
                    onClick=${() => removeMember(member)}
                  >
                    <${TrashIcon} />
                  </button>
                </div>
              </div>`
          )}
        </div>
        ${
          editingMember &&
          html`<p class="crew-editing-note">
            ${t('entry.editingCrewMember', { name: editingMember.name })}
            <button type="button" class="link-button" onClick=${cancelEditing}>
              ${t('common.cancel')}
            </button>
          </p>`
        }
        <div class="sheet-row">
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
          <button
            type="button"
            class="big-button"
            disabled=${!name.trim()}
            onClick=${editingId === null ? addNew : saveEdit}
          >
            ${editingId === null ? t('entry.addCrewMember') : t('common.save')}
          </button>
        </div>
        <div class="sheet-row">
          <button type="button" class="big-button" onClick=${onCancel}>${t('common.cancel')}</button>
          <button type="submit" class="big-button primary">${t('common.save')}</button>
        </div>
      </form>
    </div>
  `;
}
