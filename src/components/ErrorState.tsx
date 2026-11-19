interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

/** 资源加载失败时的可恢复提示。 */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="stage-overlay is-error" role="alert">
      <p className="overlay-kicker">Sequence unavailable</p>
      <h2 className="error-title">花朵暂时未能显现</h2>
      <p className="error-message">{message}</p>
      <button type="button" className="retry-button" onClick={onRetry}>
        重新尝试
      </button>
    </div>
  );
}
