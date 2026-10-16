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

export function Input({
  invalid,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }): ReactNode {
  return (
    <input className={`input ${className}`} aria-invalid={invalid ? true : undefined} {...rest} />
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
