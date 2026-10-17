import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowRight, BadgeCheck, ChevronDown, Clock3, Heart, Leaf, Menu,
  Minus, Plus, Search, ShoppingBag, SlidersHorizontal, Sprout, Truck,
  UserRound, X, PackageCheck, FileText, LayoutGrid
} from "lucide-react";
import { products } from "./data/products";
import { fetchCatalog } from "./data/catalog";
import type { Category, Product } from "./types/product";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import AuthDialog from "./components/AuthDialog";

type CartLine = { product: Product; quantity: number };
type Tab = "Découvrir" | "Mes commandes" | "Factures" | "Mon compte";

const categories: Category[] = ["Tous", "Jus frais", "Fruits", "Légumes", "Épicerie"];

const money = (value: number) =>
  new Intl.NumberFormat("fr-TN", { style: "currency", currency: "TND", maximumFractionDigits: 3 }).format(value);

export default function App() {
  const [activeCategory, setActiveCategory] = useState<Category>("Tous");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("Découvrir");
  const [notice, setNotice] = useState("");
  const [catalogProducts, setCatalogProducts] = useState<Product[]>(products);
  const [catalogLoading, setCatalogLoading] = useState(isSupabaseConfigured);
  const [catalogMessage, setCatalogMessage] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (supabase) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (mounted) setSession(nextSession);
      });
      void supabase.auth.getSession().then(({ data }) => {
        if (mounted) setSession(data.session);
      });
      void fetchCatalog()
        .then((loadedProducts) => {
          if (mounted) {
            setCatalogProducts(loadedProducts);
            setCatalogMessage(loadedProducts.length === 0 ? "Aucun produit actif dans le catalogue Supabase." : "Catalogue chargé depuis Supabase.");
          }
        })
        .catch((error: unknown) => {
          if (mounted) {
            setCatalogProducts(products);
            setCatalogMessage(error instanceof Error ? `Catalogue de démonstration : ${error.message}` : "Catalogue de démonstration : erreur Supabase.");
          }
        })
        .finally(() => { if (mounted) setCatalogLoading(false); });
      return () => {
        mounted = false;
        subscription.unsubscribe();
      };
    }
    setCatalogLoading(false);
    return () => { mounted = false; };
  }, []);

  const filteredProducts = useMemo(() => catalogProducts.filter((product) => {
    const matchesCategory = activeCategory === "Tous" || product.category === activeCategory;
    const matchesSearch = `${product.name} ${product.description}`.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch && product.available;
  }), [activeCategory, catalogProducts, search]);

  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function addToCart(product: Product) {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      return existing
        ? current.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)
        : [...current, { product, quantity: 1 }];
    });
    setNotice(`${product.name} ajouté au panier`);
    window.setTimeout(() => setNotice(""), 2200);
  }

  function changeQuantity(productId: string, delta: number) {
    setCart((current) => current
      .map((line) => line.product.id === productId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  function selectTab(tab: Tab) {
    setActiveTab(tab);
    setMobileMenu(false);
    if (tab === "Mon compte") {
      setAuthOpen(true);
      return;
    }
    if (tab !== "Découvrir") {
      setNotice("Cette rubrique sera disponible dans une prochaine étape.");
      window.setTimeout(() => setNotice(""), 3200);
    }
  }

  const navItems: { label: Tab; icon: typeof LayoutGrid }[] = [
    { label: "Découvrir", icon: LayoutGrid },
    { label: "Mes commandes", icon: PackageCheck },
    { label: "Factures", icon: FileText },
    { label: "Mon compte", icon: UserRound }
  ];

  return (
    <div className="app-shell">
      <div className="announcement"><Sprout size={14} /> Le meilleur de la nature, livré chez vous <span>·</span> Fraîcheur sélectionnée avec soin</div>
      <header className="site-header">
        <a className="brand" href="#" onClick={() => selectTab("Découvrir")} aria-label="AgriFresh, accueil">
          <span className="brand-mark"><Leaf size={23} strokeWidth={2.3} /></span>
          <span className="brand-copy"><strong>agri<span>fresh</span></strong><small>LE GOÛT DU NATUREL</small></span>
        </a>
        <nav className="desktop-nav" aria-label="Navigation principale">
          {navItems.map(({ label }) => <button key={label} className={activeTab === label ? "nav-link active" : "nav-link"} onClick={() => selectTab(label)}>{label}</button>)}
        </nav>
        <div className="header-actions">
          <button className="icon-button search-shortcut" aria-label="Rechercher" onClick={() => document.getElementById("product-search")?.focus()}><Search size={20} /></button>
          <button className="account-button" onClick={() => selectTab("Mon compte")}><UserRound size={18} /><span>{session ? "Mon compte" : "Mon espace"}</span></button>
          <button className="cart-button" onClick={() => setCartOpen(true)} aria-label={`Ouvrir le panier, ${cartCount} articles`}>
            <ShoppingBag size={19} /><span>Panier</span><b>{cartCount}</b>
          </button>
          <button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Ouvrir le menu">{mobileMenu ? <X /> : <Menu />}</button>
        </div>
        {mobileMenu && <nav className="mobile-nav">{navItems.map(({ label, icon: Icon }) => <button key={label} onClick={() => selectTab(label)}><Icon size={18} />{label}</button>)}</nav>}
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> LA NATURE, TOUT SIMPLEMENT</div>
            <h1>Du bon, du frais.<br /><em>Du vrai.</em></h1>
            <p>Des jus pleins de vitalité et des produits de la terre, soigneusement sélectionnés pour apporter le meilleur de la nature à votre table.</p>
            <button className="primary-button" onClick={() => document.getElementById("catalogue")?.scrollIntoView({ behavior: "smooth" })}>Découvrir nos produits <ArrowRight size={17} /></button>
            <div className="hero-promises">
              <span><BadgeCheck size={16} /> Sélection de qualité</span>
              <span><Sprout size={16} /> Esprit de saison</span>
            </div>
          </div>
          <div className="hero-visual">
            <img src="https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=1200&q=90" alt="Jus d'orange frais et agrumes" />
            <div className="image-note"><span className="note-icon"><Leaf size={18} /></span><span><strong>La fraîcheur à chaque gorgée</strong><small>Simplement bon, naturellement.</small></span></div>
            <div className="floating-stamp"><span>100%</span><small>PLAISIR<br />NATUREL</small></div>
          </div>
          <div className="hero-leaf leaf-one"><Leaf /></div>
          <div className="hero-leaf leaf-two"><Sprout /></div>
        </section>

        <section className="benefits" aria-label="Nos engagements">
          <div className="benefit"><span className="benefit-icon"><Sprout size={20} /></span><span><strong>Le goût de la terre</strong><small>Des produits choisis avec soin</small></span></div>
          <div className="benefit"><span className="benefit-icon"><Truck size={20} /></span><span><strong>Livraison pratique</strong><small>Suivez votre commande facilement</small></span></div>
          <div className="benefit"><span className="benefit-icon"><Heart size={20} /></span><span><strong>Du bon au quotidien</strong><small>Des essentiels pour toute la famille</small></span></div>
        </section>

        <section className="catalog-section" id="catalogue">
          <div className="section-heading">
            <div><div className="eyebrow">NOTRE SÉLECTION</div><h2>Les trésors <em>du moment</em></h2><p>Des saveurs authentiques, choisies pour vous.</p></div>
            <button className="text-button" onClick={() => { setActiveCategory("Tous"); setSearch(""); }}>Tout explorer <ArrowRight size={16} /></button>
          </div>
          <div className="catalog-tools">
            <div className="category-pills">{categories.map((category) => <button key={category} className={activeCategory === category ? "category-pill selected" : "category-pill"} onClick={() => setActiveCategory(category)}>{category}</button>)}</div>
            <label className="search-box"><Search size={18} /><input id="product-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Un produit en tête ?" /><SlidersHorizontal size={17} /></label>
          </div>
          <div className="catalog-status" role="status">
            {catalogLoading ? "Chargement du catalogue…" : catalogMessage || (isSupabaseConfigured ? "Catalogue Supabase" : "Produits de démonstration")}
          </div>
          <div className="product-grid">
            {filteredProducts.map((product) => <article className="product-card" key={product.id}>
              <div className="product-image-wrap">
                <img src={product.image} alt={product.name} loading="lazy" />
                {product.badge && <span className="product-badge">{product.badge}</span>}
                <button className="favorite-button" aria-label={`Ajouter ${product.name} aux favoris`} onClick={() => { setNotice("Les favoris seront disponibles avec ton compte client."); window.setTimeout(() => setNotice(""), 2500); }}><Heart size={17} /></button>
              </div>
              <div className="product-info">
                <span className="product-category">{product.category}</span>
                <h3>{product.name}</h3><p>{product.description}</p>
                <div className="product-bottom"><div><strong>{money(product.price)}</strong><small>{product.unit}</small></div><button className="add-button" onClick={() => addToCart(product)} aria-label={`Ajouter ${product.name} au panier`}><Plus size={19} /></button></div>
              </div>
            </article>)}
          </div>
          {filteredProducts.length === 0 && <div className="empty-state"><Search size={28} /><h3>Aucun produit trouvé</h3><p>Essayez une autre recherche ou une autre catégorie.</p><button className="text-button" onClick={() => { setSearch(""); setActiveCategory("Tous"); }}>Réinitialiser les filtres</button></div>}
        </section>

        <section className="season-banner">
          <div className="season-art"><img src="https://images.unsplash.com/photo-1547514701-42782101795e?auto=format&fit=crop&w=700&q=85" alt="Agrumes frais" /></div>
          <div className="season-copy"><span className="eyebrow">AU RYTHME DES SAISONS</span><h2>La nature a<br />toujours <em>bon goût.</em></h2><p>Retrouvez les fruits, les légumes et les saveurs qui font du bien, au fil des récoltes.</p><button className="light-button" onClick={() => { setActiveCategory("Fruits"); document.getElementById("catalogue")?.scrollIntoView({ behavior: "smooth" }); }}>Explorer les fruits <ArrowRight size={16} /></button></div>
        </section>

        <section className="bottom-trust"><div><Clock3 size={19} /><span><strong>Un parcours simple</strong><small>De la sélection à la commande</small></span></div><div><PackageCheck size={19} /><span><strong>Un suivi clair</strong><small>Les étapes de votre commande</small></span></div><div><FileText size={19} /><span><strong>Vos documents au même endroit</strong><small>Historique et factures dans votre espace</small></span></div></section>
      </main>

      <footer className="footer"><a className="brand footer-brand" href="#"><span className="brand-mark"><Leaf size={21} /></span><span className="brand-copy"><strong>agri<span>fresh</span></strong><small>LE GOÛT DU NATUREL</small></span></a><p>Des produits simples, de belles saveurs et un peu de nature au quotidien.</p><span>© {new Date().getFullYear()} AgriFresh · Démonstration</span></footer>

      {notice && <div className="toast" role="status"><BadgeCheck size={18} />{notice}</div>}

      {authOpen && <AuthDialog session={session} onClose={() => setAuthOpen(false)} />}

      {cartOpen && <div className="drawer-backdrop" onClick={() => setCartOpen(false)}>
        <aside className="cart-drawer" onClick={(event) => event.stopPropagation()} aria-label="Votre panier">
          <div className="drawer-header"><div><span className="eyebrow">VOTRE SÉLECTION</span><h2>Mon panier <span>({cartCount})</span></h2></div><button className="icon-button" onClick={() => setCartOpen(false)} aria-label="Fermer le panier"><X /></button></div>
          {cart.length === 0 ? <div className="cart-empty"><span><ShoppingBag size={30} /></span><h3>Votre panier est encore vide</h3><p>Les bonnes choses commencent par une première sélection.</p><button className="primary-button" onClick={() => setCartOpen(false)}>Découvrir les produits</button></div> : <>
            <div className="cart-lines">{cart.map(({ product, quantity }) => <div className="cart-line" key={product.id}><img src={product.image} alt="" /><div className="cart-line-copy"><strong>{product.name}</strong><small>{product.unit}</small><b>{money(product.price * quantity)}</b><div className="quantity-control"><button onClick={() => changeQuantity(product.id, -1)} aria-label="Diminuer"><Minus size={13} /></button><span>{quantity}</span><button onClick={() => changeQuantity(product.id, 1)} aria-label="Augmenter"><Plus size={13} /></button></div></div></div>)}</div>
            <div className="cart-summary"><div><span>Sous-total</span><strong>{money(cartTotal)}</strong></div><small>Les frais de livraison seront confirmés avant validation.</small><button className="primary-button full-button" onClick={() => { setCartOpen(false); setNotice("La validation de commande sera activée après connexion au backend."); window.setTimeout(() => setNotice(""), 3500); }}>Continuer la commande <ArrowRight size={17} /></button><button className="clear-cart" onClick={() => setCart([])}>Vider le panier</button></div>
          </>}
        </aside>
      </div>}
      <div className="connection-note">{session ? "Connecté à Supabase" : isSupabaseConfigured ? "Configuration Supabase détectée" : "Mode démonstration · backend à configurer" } <ChevronDown size={13} /></div>
    </div>
  );
}