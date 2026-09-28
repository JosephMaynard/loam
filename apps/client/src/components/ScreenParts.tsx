import type { ComponentChildren } from "preact";

/**
 * The title row of a `.card`: a 16px title, an optional muted description, and optional trailing actions
 * (a Refresh button, say). `level` keeps the outline right: 2 under a screen's h1, 3 inside an admin section.
 */
export function CardHeader({
  actions,
  description,
  level = 2,
  title,
  titleId,
}: {
  actions?: ComponentChildren;
  description?: ComponentChildren;
  level?: 2 | 3;
  title: ComponentChildren;
  titleId?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="card-header">
      <div className="card-header-text">
        <Heading className="card-title" id={titleId}>
          {title}
        </Heading>
        {description ? <p className="card-description">{description}</p> : null}
      </div>
      {actions ? <div className="card-header-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * A settings switch: label (and optional description) on the start side, a CSS switch
 * (`input.toggle`, a real checkbox) on the end. The whole row is the hit target.
 */
export function SwitchRow({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  description?: ComponentChildren;
  disabled?: boolean;
  label: ComponentChildren;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={disabled ? "switch-row is-disabled" : "switch-row"}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {description ? <span className="switch-description">{description}</span> : null}
      </span>
      <input
        checked={checked}
        className="toggle"
        disabled={disabled}
        onInput={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
  );
}
