// Splash shown to unauthenticated visitors. Plain <a href> (not a fetch) so the
// browser does a top-level navigation to the OAuth start route — the session
// cookie set on callback then arrives on the redirect back.
export function LoginScreen() {
  return (
    <div className="login">
      <div className="login-card">
        <h1>home-lab</h1>
        <p className="login-meta">sign in to continue</p>
        <a className="login-btn" href="/api/auth/login">Sign in with Discord</a>
      </div>
    </div>
  );
}
