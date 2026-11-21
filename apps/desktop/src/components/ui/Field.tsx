import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/** A label that wraps its control (so clicking the label focuses it) with optional hint and error text. */
export function Field({
  label,
  hint,
  error,
  className = '',
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className={`field ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/** Number boxes (qty, price, cost) often come prefilled; typing must replace the old value, not append to it. */
const selectsOnFocus = (mode: InputHTMLAttributes<HTMLInputElement>['inputMode']): boolean =>
  mode === 'decimal' || mode === 'numeric';

export function Input({
  invalid,
  className = '',
  onFocus,
  onMouseUp,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }): ReactNode {
  const select = selectsOnFocus(rest.inputMode);
  return (
    <input
      className={`input ${className}`}
      aria-invalid={invalid ? true : undefined}
      onFocus={(e) => {
        if (select) {
          e.currentTarget.select();
          e.currentTarget.dataset.justFocused = '1';
        }
        onFocus?.(e);
      }}
      onMouseUp={(e) => {
        // the mouseup of the focusing click would otherwise drop the selection again
        if (e.currentTarget.dataset.justFocused) {
          delete e.currentTarget.dataset.justFocused;
          e.preventDefault();
        }
        onMouseUp?.(e);
      }}
      {...rest}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea className={`textarea ${className}`} {...rest} />;
}
