import { useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { BadgeCheck, Leaf, LoaderCircle, X } from "lucide-react";
import { isSupabaseConfigured, supabase } from "../lib/supabase";

type AuthDialogProps = {
  session: Session | null;
  onClose: () => void;
};

export default function AuthDialog({ session, onClose }: AuthDialogProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setBusy(true);
    setMessage("");
    setErrorMessage("");
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName.trim(), phone: phone.trim() } }
        });
        if (error) throw error;
        setMessage(data.session
          ? "Votre compte est créé. Vous êtes connecté·e."
          : "Compte créé. Consultez votre boîte mail pour confirmer votre adresse.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMessage("Connexion réussie.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Une erreur est survenue.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    setBusy(true);
    setErrorMessage("");
    const { error } = await supabase.auth.signOut();
    if (error) setErrorMessage(error.message);
    setBusy(false);
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="auth-close icon-button" type="button" onClick={onClose} aria-label="Fermer"><X size={19} /></button>
        <div className="auth-brand"><span className="brand-mark"><Leaf size={22} /></span><span className="eyebrow">VOTRE ESPACE AGRIFRESH</span></div>

        {!isSupabaseConfigured ? <>
          <h2 id="auth-title">Connexion à configurer</h2>
          <p className="auth-description">Ajoutez l’URL de votre projet et sa clé publique Supabase dans <strong>.env.local</strong>, puis redémarrez le serveur Vite.</p>
          <button className="primary-button full-button" type="button" onClick={onClose}>J’ai compris</button>
        </> : session ? <>
          <h2 id="auth-title">Bonjour{session.user.user_metadata.full_name ? `, ${session.user.user_metadata.full_name}` : ""} !</h2>
          <p className="auth-description">Connecté·e avec <strong>{session.user.email}</strong></p>
          {message && <p className="auth-message" role="status"><BadgeCheck size={16} />{message}</p>}
          {errorMessage && <p className="auth-error" role="alert">{errorMessage}</p>}
          <button className="primary-button full-button" type="button" onClick={signOut} disabled={busy}>{busy ? "Déconnexion…" : "Se déconnecter"}</button>
        </> : <>
          <h2 id="auth-title">{mode === "signin" ? "Ravi de vous revoir." : "Rejoignez-nous."}</h2>
          <p className="auth-description">{mode === "signin" ? "Connectez-vous pour retrouver votre espace client." : "Créez votre compte pour profiter de votre espace client."}</p>
          <div className="auth-tabs" role="tablist" aria-label="Type d’accès">
            <button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "selected" : ""} onClick={() => { setMode("signin"); setErrorMessage(""); setMessage(""); }}>Connexion</button>
            <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "selected" : ""} onClick={() => { setMode("signup"); setErrorMessage(""); setMessage(""); }}>Créer un compte</button>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {mode === "signup" && <>
              <label>Nom complet<input autoComplete="name" required value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
              <label>Téléphone <span>(facultatif)</span><input type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
            </>}
            <label>Adresse e-mail<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Mot de passe<input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {message && <p className="auth-message" role="status"><BadgeCheck size={16} />{message}</p>}
            {errorMessage && <p className="auth-error" role="alert">{errorMessage}</p>}
            <button className="primary-button full-button" type="submit" disabled={busy}>
              {busy ? <><LoaderCircle className="auth-spinner" size={16} /> Traitement…</> : mode === "signin" ? "Se connecter" : "Créer mon compte"}
            </button>
          </form>
          <p className="auth-privacy">Vos données sont protégées par les règles d’accès Supabase.</p>
        </>}
      </section>
    </div>
  );
}
