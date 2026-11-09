/** An on/off switch (role="switch"): click, Space or Enter flips it. */
export default function Switch({ checked, onChange, disabled, id, label, labelledBy }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={!!checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={"switch" + (checked ? " is-on" : "")}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        // A button already fires click on Space/Enter; this keeps Enter from also submitting a form.
        if (e.key === "Enter") {
          e.preventDefault();
          if (!disabled) onChange(!checked);
        }
      }}
    >
      <span className="switch-thumb" />
    </button>
  );
}
