interface TextToggleProps {
  text: string;
  active: boolean;
  onClick: () => void;
}

export function TextToggle({ text, active, onClick }: TextToggleProps) {
  return (
    <button
      type="button"
      className={`text-toggle ${active ? 'active' : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {text}
    </button>
  );
}
