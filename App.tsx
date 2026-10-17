import { useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { products as demoProducts } from "./src/data/products";
import type { Category, Product } from "./src/types/product";
import { isSupabaseConfigured, supabase } from "./src/lib/supabase";
import { fetchCatalog } from "./src/data/catalog";
import { fetchFavoriteIds, setFavorite } from "./src/data/favorites";
import { fetchCustomerOrders, placeCustomerOrder, type CustomerOrder, type DeliveryAddress } from "./src/data/orders";
import type { CartLine } from "./src/types/order";

const categories: Category[] = ["Tous", "Jus frais", "Fruits", "Légumes", "Épicerie"];
type Tab = "Découvrir" | "Commandes" | "Favoris" | "Compte";
const CART_STORAGE_KEY = "agrifresh-cart-v1";
const AUTH_CALLBACK_URL = "agrifresh://auth/callback";

const formatPrice = (amount: number) =>
  `${new Intl.NumberFormat("fr-TN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(amount)} TND`;

function NativeApp() {
  const [catalog, setCatalog] = useState<Product[]>(demoProducts);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [catalogMessage, setCatalogMessage] = useState("");
  const [category, setCategory] = useState<Category>("Tous");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartVisible, setCartVisible] = useState(false);
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [ordersVisible, setOrdersVisible] = useState(false);
  const [favoritesVisible, setFavoritesVisible] = useState(false);
  const [authVisible, setAuthVisible] = useState(false);
  const [tab, setTab] = useState<Tab>("Découvrir");
  const [session, setSession] = useState<Session | null>(null);
  const [liveCatalog, setLiveCatalog] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [cartHydrated, setCartHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(CART_STORAGE_KEY)
      .then((stored) => {
        if (active && stored) {
          const parsed = JSON.parse(stored) as CartLine[];
          if (Array.isArray(parsed)) setCart(parsed);
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setCartHydrated(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const authClient = supabase;

    async function handleAuthCallback(url: string | null) {
      if (!url) return;
      try {
        const parsedUrl = new URL(url);
        const query = parsedUrl.searchParams;
        const fragment = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""));
        const errorDescription = query.get("error_description") ?? fragment.get("error_description");
        if (errorDescription) {
          Alert.alert("Confirmation e-mail", decodeURIComponent(errorDescription.replace(/\+/g, " ")));
          return;
        }

        const code = query.get("code");
        if (code) {
          const { error } = await authClient.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          const accessToken = fragment.get("access_token") ?? query.get("access_token");
          const refreshToken = fragment.get("refresh_token") ?? query.get("refresh_token");
          if (!accessToken || !refreshToken) return;
          const { error } = await authClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (error) throw error;
        }
        setAuthVisible(true);
        Alert.alert("E-mail confirmé", "Votre compte est maintenant connecté.");
      } catch (error) {
        Alert.alert("Confirmation e-mail", error instanceof Error ? error.message : "Le lien de confirmation est invalide ou expiré.");
      }
    }

    const subscription = Linking.addEventListener("url", ({ url }) => { void handleAuthCallback(url); });
    void Linking.getInitialURL().then(handleAuthCallback);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!cartHydrated) return;
    void AsyncStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart)).catch(() => {});
  }, [cart, cartHydrated]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    if (supabase) {
      const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        if (active) setSession(nextSession);
      });
      unsubscribe = () => data.subscription.unsubscribe();

      void supabase.auth.getSession().then(({ data: sessionData }) => {
        if (active) setSession(sessionData.session);
      });

      void fetchCatalog()
        .then((items) => {
          if (!active) return;
          setCatalog(items);
          setLiveCatalog(true);
          setCatalogMessage(items.length ? "Catalogue synchronisé" : "Aucun produit actif pour le moment");
        })
        .catch((error: unknown) => {
          if (!active) return;
          setCatalog(demoProducts);
          setLiveCatalog(false);
          setCatalogMessage(error instanceof Error ? "Catalogue de démonstration · connexion indisponible" : "Catalogue de démonstration");
        })
        .finally(() => { if (active) setLoading(false); });
    } else {
      setCatalogMessage("Produits de démonstration · Supabase non configuré");
      setLoading(false);
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!session || !supabase) {
      setFavoriteIds([]);
      return () => { active = false; };
    }
    void fetchFavoriteIds()
      .then((ids) => { if (active) setFavoriteIds(ids); })
      .catch((error: unknown) => {
        if (active) Alert.alert("Favoris", error instanceof Error ? error.message : "Impossible de charger les favoris.");
      });
    return () => { active = false; };
  }, [session?.user.id]);

  const visibleProducts = useMemo(() => catalog.filter((product) => {
    const categoryMatch = category === "Tous" || product.category === category;
    const searchMatch = `${product.name} ${product.description}`.toLocaleLowerCase("fr").includes(search.trim().toLocaleLowerCase("fr"));
    return product.available && categoryMatch && searchMatch;
  }), [catalog, category, search]);
  const productRows = useMemo(() => {
    const rows: Product[][] = [];
    for (let index = 0; index < visibleProducts.length; index += 2) {
      rows.push(visibleProducts.slice(index, index + 2));
    }
    return rows;
  }, [visibleProducts]);

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  function addToCart(product: Product) {
    setCart((current) => {
      const found = current.find((line) => line.product.id === product.id);
      return found
        ? current.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)
        : [...current, { product, quantity: 1 }];
    });
  }

  function updateQuantity(productId: string, delta: number) {
    setCart((current) => current
      .map((line) => line.product.id === productId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  async function toggleFavorite(product: Product) {
    if (!session) {
      Alert.alert("Connexion requise", "Connectez-vous pour enregistrer vos favoris.", [
        { text: "Annuler", style: "cancel" },
        { text: "Se connecter", onPress: () => setAuthVisible(true) },
      ]);
      return;
    }
    const wasFavorite = favoriteIds.includes(product.id);
    setFavoriteIds((current) => wasFavorite ? current.filter((id) => id !== product.id) : [...current, product.id]);
    try {
      await setFavorite(session.user.id, product.id, !wasFavorite);
    } catch (error) {
      setFavoriteIds((current) => wasFavorite ? [...current, product.id] : current.filter((id) => id !== product.id));
      Alert.alert("Favoris", error instanceof Error ? error.message : "Impossible de mettre à jour ce favori.");
    }
  }

  function startCheckout() {
    if (!session) {
      setCartVisible(false);
      Alert.alert("Connexion requise", "Connectez-vous avant de valider votre commande.", [
        { text: "Annuler", style: "cancel" },
        { text: "Se connecter", onPress: () => setAuthVisible(true) },
      ]);
      return;
    }
    if (!liveCatalog) {
      Alert.alert("Catalogue indisponible", "La commande en ligne est désactivée tant que le catalogue Supabase n’est pas chargé.");
      return;
    }
    setCartVisible(false);
    setCheckoutVisible(true);
  }

  async function submitOrder(address: DeliveryAddress, note: string) {
    const order = await placeCustomerOrder(cart, address, note);
    setCart([]);
    setCheckoutVisible(false);
    Alert.alert("Commande confirmée", `Commande #${order.order_number} enregistrée. Paiement à la livraison : ${formatPrice(order.total)}.`);
  }

  function selectTab(next: Tab) {
    setTab(next);
    if (next === "Compte") setAuthVisible(true);
    else if (next === "Commandes" || next === "Favoris") {
      if (!session) {
        Alert.alert("Connexion requise", `Connectez-vous pour consulter ${next.toLocaleLowerCase("fr")}.`, [
          { text: "Annuler", style: "cancel" },
          { text: "Se connecter", onPress: () => setAuthVisible(true) },
        ]);
      } else if (next === "Commandes") setOrdersVisible(true);
      else setFavoritesVisible(true);
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.paper} />
        <View style={styles.topBar}>
          <View style={styles.brandMark}><Text style={styles.brandLeaf}>✦</Text></View>
          <View style={styles.brandText}><Text style={styles.brandName}>agri<Text style={styles.brandAccent}>fresh</Text></Text><Text style={styles.brandTagline}>LE GOÛT DU NATUREL</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Ouvrir le panier" style={styles.bagButton} onPress={() => setCartVisible(true)}>
            <Text style={styles.bagIcon}>♧</Text><Text style={styles.bagLabel}>Panier</Text><Text style={styles.bagCount}>{cartCount}</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.announcement}><Text style={styles.announcementText}>✳  LE MEILLEUR DE LA NATURE, LIVRÉ CHEZ VOUS</Text></View>
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>LA NATURE, TOUT SIMPLEMENT</Text>
            <Text style={styles.heroTitle}>Du bon, du frais.{"\n"}<Text style={styles.heroAccent}>Du vrai.</Text></Text>
            <Text style={styles.heroBody}>Des jus pleins de vitalité et des produits de la terre, sélectionnés avec soin pour votre table.</Text>
            <Pressable style={styles.heroButton} onPress={() => setCategory("Tous")}><Text style={styles.heroButtonText}>DÉCOUVRIR LA SÉLECTION  →</Text></Pressable>
            <View style={styles.heroImageFrame}><Image source={{ uri: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=1200&q=85" }} style={styles.heroImage} /><View style={styles.imageCaption}><Text style={styles.imageCaptionIcon}>✿</Text><View><Text style={styles.imageCaptionTitle}>La fraîcheur à chaque gorgée</Text><Text style={styles.imageCaptionBody}>Simplement bon, naturellement.</Text></View></View></View>
          </View>

          <View style={styles.promiseRow}><TrustPoint title="Sélection de qualité" icon="✳" /><TrustPoint title="Esprit de saison" icon="❋" /></View>

          <View style={styles.sectionHeader}>
            <Text style={styles.eyebrow}>NOTRE SÉLECTION</Text>
            <Text style={styles.sectionTitle}>Les trésors <Text style={styles.heroAccent}>du moment</Text></Text>
            <Text style={styles.sectionSubtitle}>Des saveurs authentiques, choisies pour vous.</Text>
          </View>

          <View style={styles.searchWrap}><Text style={styles.searchIcon}>⌕</Text><TextInput value={search} onChangeText={setSearch} placeholder="Un produit en tête ?" placeholderTextColor={colors.muted} style={styles.searchInput} returnKeyType="search" /></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
            {categories.map((item) => <Pressable key={item} onPress={() => setCategory(item)} style={[styles.categoryChip, category === item && styles.categoryChipSelected]}><Text style={[styles.categoryText, category === item && styles.categoryTextSelected]}>{item}</Text></Pressable>)}
          </ScrollView>

          <View style={styles.catalogMeta}>
            <Text style={styles.catalogCount}>{loading ? "Chargement…" : `${visibleProducts.length} produit${visibleProducts.length === 1 ? "" : "s"}`}</Text>
            <Text style={styles.catalogMessage}>{catalogMessage}</Text>
          </View>

          {loading ? <View style={styles.loading}><ActivityIndicator color={colors.green} /><Text style={styles.loadingText}>Chargement des produits…</Text></View> : visibleProducts.length === 0 ? (
            <View style={styles.emptyState}><Text style={styles.emptyTitle}>Aucun produit trouvé</Text><Text style={styles.emptyBody}>Essayez une autre recherche ou une autre catégorie.</Text><Pressable onPress={() => { setSearch(""); setCategory("Tous"); }}><Text style={styles.resetText}>Réinitialiser les filtres</Text></Pressable></View>
          ) : (
            <View style={styles.productGrid}>
              {productRows.map((row, index) => <View key={`product-row-${index}`} style={styles.productRow}>
                {row.map((item) => <ProductCard key={item.id} product={item} isFavorite={favoriteIds.includes(item.id)} onFavorite={() => toggleFavorite(item)} onAdd={() => addToCart(item)} />)}
                {row.length === 1 ? <View style={styles.productCardSpacer} /> : null}
              </View>)}
            </View>
          )}

          <View style={styles.seasonBanner}><Text style={styles.eyebrowLight}>AU RYTHME DES SAISONS</Text><Text style={styles.seasonTitle}>La nature a toujours <Text style={styles.seasonAccent}>bon goût.</Text></Text><Text style={styles.seasonBody}>Les fruits, légumes et saveurs qui font du bien, au fil des récoltes.</Text><Pressable style={styles.seasonButton} onPress={() => setCategory("Fruits")}><Text style={styles.seasonButtonText}>EXPLORER LES FRUITS  →</Text></Pressable></View>
          <Text style={styles.footerNote}>AgriFresh · Des produits simples, de belles saveurs.</Text>
        </ScrollView>

        <View style={styles.bottomNav}>
          <NavButton label="Découvrir" icon="⌂" selected={tab === "Découvrir"} onPress={() => selectTab("Découvrir")} />
          <NavButton label="Commandes" icon="▤" selected={tab === "Commandes"} onPress={() => selectTab("Commandes")} />
          <NavButton label="Favoris" icon="♡" selected={tab === "Favoris"} onPress={() => selectTab("Favoris")} />
          <NavButton label="Compte" icon="◉" selected={tab === "Compte"} onPress={() => selectTab("Compte")} />
        </View>

        <CartModal visible={cartVisible} cart={cart} total={total} count={cartCount} onClose={() => setCartVisible(false)} onQuantity={updateQuantity} onClear={() => setCart([])} onCheckout={startCheckout} />
        <CheckoutModal visible={checkoutVisible} cart={cart} total={total} session={session} onClose={() => setCheckoutVisible(false)} onSubmit={submitOrder} />
        <OrdersModal visible={ordersVisible} onClose={() => setOrdersVisible(false)} />
        <FavoritesModal visible={favoritesVisible} products={catalog.filter((product) => favoriteIds.includes(product.id))} onClose={() => setFavoritesVisible(false)} onAdd={addToCart} onRemove={(product) => toggleFavorite(product)} />
        <AuthModal visible={authVisible} session={session} onClose={() => setAuthVisible(false)} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function TrustPoint({ title, icon }: { title: string; icon: string }) {
  return <View style={styles.promise}><Text style={styles.promiseIcon}>{icon}</Text><Text style={styles.promiseText}>{title}</Text></View>;
}

function ProductCard({ product, isFavorite, onFavorite, onAdd }: { product: Product; isFavorite: boolean; onFavorite: () => void; onAdd: () => void }) {
  return <View style={styles.productCard}>
    <View style={styles.productImageWrap}>
      <Image source={{ uri: product.image }} style={styles.productImage} />
      {product.badge ? <View style={styles.productBadge}><Text style={styles.productBadgeText}>{product.badge}</Text></View> : null}
      <Pressable style={styles.favoriteButton} onPress={onFavorite} accessibilityLabel={`${isFavorite ? "Retirer" : "Ajouter"} ${product.name} ${isFavorite ? "des" : "aux"} favoris`}><Text style={[styles.favoriteIcon, isFavorite && styles.favoriteIconSelected]}>{isFavorite ? "♥" : "♡"}</Text></Pressable>
    </View>
    <View style={styles.productInfo}>
      <Text style={styles.productCategory}>{product.category.toLocaleUpperCase("fr")}</Text>
      <Text numberOfLines={2} style={styles.productName}>{product.name}</Text>
      <Text numberOfLines={2} style={styles.productDescription}>{product.description}</Text>
      <View style={styles.productBottom}><View style={styles.priceBlock}><Text style={styles.productPrice}>{formatPrice(product.price)}</Text><Text style={styles.productUnit}>{product.unit}</Text></View><Pressable style={styles.addButton} onPress={onAdd} accessibilityLabel={`Ajouter ${product.name} au panier`}><Text style={styles.addButtonText}>＋</Text></Pressable></View>
    </View>
  </View>;
}

function NavButton({ label, icon, selected, onPress }: { label: Tab; icon: string; selected: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.navItem}><Text style={[styles.navIcon, selected && styles.navIconActive]}>{icon}</Text><Text style={[styles.navLabel, selected && styles.navLabelActive]}>{label}</Text></Pressable>;
}

function CartModal({ visible, cart, total, count, onClose, onQuantity, onClear, onCheckout }: {
  visible: boolean; cart: CartLine[]; total: number; count: number; onClose: () => void;
  onQuantity: (id: string, delta: number) => void; onClear: () => void; onCheckout: () => void;
}) {
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalSafe}>
      <View style={styles.modalHeader}><View><Text style={styles.eyebrow}>VOTRE SÉLECTION</Text><Text style={styles.modalTitle}>Mon panier ({count})</Text></View><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
      {cart.length === 0 ? <View style={styles.cartEmpty}><Text style={styles.cartEmptyIcon}>♧</Text><Text style={styles.cartEmptyTitle}>Votre panier est encore vide</Text><Text style={styles.cartEmptyBody}>Les bonnes choses commencent par une première sélection.</Text><Pressable style={styles.heroButton} onPress={onClose}><Text style={styles.heroButtonText}>DÉCOUVRIR LES PRODUITS</Text></Pressable></View> : <>
        <FlatList data={cart} keyExtractor={(item) => item.product.id} contentContainerStyle={styles.cartList} renderItem={({ item }) => <View style={styles.cartLine}><Image source={{ uri: item.product.image }} style={styles.cartImage} /><View style={styles.cartDetails}><Text style={styles.cartProductName}>{item.product.name}</Text><Text style={styles.productUnit}>{item.product.unit}</Text><Text style={styles.cartPrice}>{formatPrice(item.product.price * item.quantity)}</Text><View style={styles.quantityControl}><Pressable onPress={() => onQuantity(item.product.id, -1)}><Text style={styles.quantityButton}>−</Text></Pressable><Text style={styles.quantityValue}>{item.quantity}</Text><Pressable onPress={() => onQuantity(item.product.id, 1)}><Text style={styles.quantityButton}>＋</Text></Pressable></View></View></View>} />
        <View style={styles.cartSummary}><View style={styles.summaryRow}><Text style={styles.summaryLabel}>Sous-total</Text><Text style={styles.summaryValue}>{formatPrice(total)}</Text></View><Text style={styles.cartHint}>Paiement à la livraison · Frais de livraison : 0 TND pour le moment.</Text><Pressable style={styles.heroButton} onPress={onCheckout}><Text style={styles.heroButtonText}>CONTINUER LA COMMANDE</Text></Pressable><Pressable onPress={onClear} style={styles.clearCart}><Text style={styles.clearCartText}>Vider le panier</Text></Pressable></View>
      </>}
    </SafeAreaView>
  </Modal>;
}

function CheckoutModal({ visible, cart, total, session, onClose, onSubmit }: {
  visible: boolean;
  cart: CartLine[];
  total: number;
  session: Session | null;
  onClose: () => void;
  onSubmit: (address: DeliveryAddress, note: string) => Promise<void>;
}) {
  const [recipient, setRecipient] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setRecipient(session?.user.user_metadata.full_name ?? "");
    setPhone(session?.user.user_metadata.phone ?? "");
    setAddress("");
    setCity("");
    setNote("");
    setError("");
  }, [visible, session?.user.id]);

  async function confirm() {
    if (!recipient.trim() || !phone.trim() || !address.trim() || !city.trim()) {
      setError("Renseignez le nom, le téléphone, l’adresse et la ville.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        recipient_name: recipient.trim(),
        phone: phone.trim(),
        address_line: address.trim(),
        city: city.trim(),
        notes: note.trim(),
      }, note);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La commande n’a pas pu être enregistrée.");
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalSafe}>
      <KeyboardAvoidingView style={styles.authContainer} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalHeader}><View><Text style={styles.eyebrow}>DERNIÈRE ÉTAPE</Text><Text style={styles.modalTitle}>Livraison</Text></View><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.authForm}>
          <Text style={styles.authHelp}>Commande de {cart.length} article(s) · {formatPrice(total)}. Paiement en espèces à la livraison.</Text>
          <AuthField label="Nom du destinataire" value={recipient} onChangeText={setRecipient} autoCapitalize="words" />
          <AuthField label="Téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <AuthField label="Adresse complète" value={address} onChangeText={setAddress} />
          <AuthField label="Ville" value={city} onChangeText={setCity} autoCapitalize="words" />
          <AuthField label="Note au livreur (facultatif)" value={note} onChangeText={setNote} multiline />
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Total à payer à la livraison</Text><Text style={styles.summaryValue}>{formatPrice(total)}</Text></View>
          {error ? <Text style={styles.errorMessage}>{error}</Text> : null}
          <Pressable style={[styles.heroButton, busy && styles.buttonBusy]} disabled={busy} onPress={confirm}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.heroButtonText}>CONFIRMER LA COMMANDE</Text>}</Pressable>
          <Text style={styles.privacyText}>Le prix et le stock sont revérifiés côté serveur au moment de la commande.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function OrdersModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true);
    setError("");
    void fetchCustomerOrders()
      .then((rows) => { if (active) setOrders(rows); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Impossible de charger les commandes."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible]);

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalSafe}>
      <View style={styles.modalHeader}><View><Text style={styles.eyebrow}>VOTRE ESPACE CLIENT</Text><Text style={styles.modalTitle}>Mes commandes</Text></View><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
      {loading ? <View style={styles.loading}><ActivityIndicator color={colors.green} /><Text style={styles.loadingText}>Chargement…</Text></View> : error ? <View style={styles.emptyState}><Text style={styles.errorMessage}>{error}</Text></View> : orders.length === 0 ? <View style={styles.emptyState}><Text style={styles.emptyTitle}>Pas encore de commande</Text><Text style={styles.emptyBody}>Vos commandes confirmées apparaîtront ici.</Text></View> : <FlatList data={orders} keyExtractor={(order) => order.id} contentContainerStyle={styles.orderList} renderItem={({ item }) => <View style={styles.orderCard}>
        <View style={styles.summaryRow}><Text style={styles.orderNumber}>Commande #{item.order_number}</Text><Text style={styles.orderStatus}>{statusLabel(item.status)}</Text></View>
        <Text style={styles.orderDate}>{new Date(item.created_at).toLocaleDateString("fr-TN", { dateStyle: "medium" })} · Paiement à la livraison</Text>
        {item.order_items.map((line, index) => <Text key={`${item.id}-${index}`} style={styles.orderLine}>{line.quantity} × {line.product_name_snapshot} · {formatPrice(Number(line.line_total))}</Text>)}
        <View style={[styles.summaryRow, styles.orderTotalRow]}><Text style={styles.summaryLabel}>Total</Text><Text style={styles.summaryValue}>{formatPrice(Number(item.total))}</Text></View>
      </View>} />}
    </SafeAreaView>
  </Modal>;
}

function FavoritesModal({ visible, products, onClose, onAdd, onRemove }: {
  visible: boolean;
  products: Product[];
  onClose: () => void;
  onAdd: (product: Product) => void;
  onRemove: (product: Product) => void;
}) {
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalSafe}>
      <View style={styles.modalHeader}><View><Text style={styles.eyebrow}>VOTRE SÉLECTION</Text><Text style={styles.modalTitle}>Mes favoris</Text></View><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
      {products.length === 0 ? <View style={styles.emptyState}><Text style={styles.emptyTitle}>Aucun favori pour l’instant</Text><Text style={styles.emptyBody}>Touchez le cœur d’un produit pour le retrouver ici.</Text></View> : <ScrollView contentContainerStyle={styles.productGrid}>
        {products.map((product) => <View key={product.id} style={styles.favoriteRow}><ProductCard product={product} isFavorite onFavorite={() => onRemove(product)} onAdd={() => onAdd(product)} /></View>)}
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Reçue",
    confirmed: "Confirmée",
    preparing: "En préparation",
    ready: "Prête",
    out_for_delivery: "En livraison",
    delivered: "Livrée",
    cancelled: "Annulée",
  };
  return labels[status] ?? status;
}

function AuthModal({ visible, session, onClose }: { visible: boolean; session: Session | null; onClose: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    if (!supabase) return;
    setBusy(true); setMessage(""); setError("");
    try {
      if (mode === "signup") {
        const { data, error: authError } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: AUTH_CALLBACK_URL, data: { full_name: name.trim(), phone: phone.trim() } } });
        if (authError) throw authError;
        setMessage(data.session ? "Compte créé, vous êtes connecté·e." : "Compte créé. Consultez votre e-mail pour confirmer votre adresse.");
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
        setMessage("Connexion réussie.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Une erreur est survenue.");
    } finally { setBusy(false); }
  }

  async function signOut() {
    if (!supabase) return;
    setBusy(true); setError("");
    const { error: authError } = await supabase.auth.signOut();
    if (authError) setError(authError.message);
    else setMessage("Vous êtes déconnecté·e.");
    setBusy(false);
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalSafe}>
      <KeyboardAvoidingView style={styles.authContainer} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalHeader}><View><Text style={styles.eyebrow}>VOTRE ESPACE AGRIFRESH</Text><Text style={styles.modalTitle}>{session ? "Mon compte" : mode === "signin" ? "Bienvenue." : "Nous rejoindre."}</Text></View><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View>
        {!isSupabaseConfigured ? <Text style={styles.authHelp}>La configuration Supabase est manquante dans les variables EXPO_PUBLIC.</Text> : session ? <View style={styles.authForm}><Text style={styles.authHelp}>Connecté·e avec {session.user.email}</Text>{session.user.user_metadata.full_name ? <Text style={styles.authHelp}>Bonjour, {session.user.user_metadata.full_name}</Text> : null}{message ? <Text style={styles.successMessage}>{message}</Text> : null}{error ? <Text style={styles.errorMessage}>{error}</Text> : null}<Pressable style={styles.heroButton} disabled={busy} onPress={signOut}><Text style={styles.heroButtonText}>{busy ? "DÉCONNEXION…" : "SE DÉCONNECTER"}</Text></Pressable></View> : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.authForm}>
          <Text style={styles.authHelp}>{mode === "signin" ? "Connectez-vous pour retrouver votre espace client." : "Créez votre compte client AgriFresh."}</Text>
          <View style={styles.authTabs}><Pressable onPress={() => { setMode("signin"); setError(""); setMessage(""); }} style={[styles.authTab, mode === "signin" && styles.authTabActive]}><Text style={[styles.authTabText, mode === "signin" && styles.authTabTextActive]}>Connexion</Text></Pressable><Pressable onPress={() => { setMode("signup"); setError(""); setMessage(""); }} style={[styles.authTab, mode === "signup" && styles.authTabActive]}><Text style={[styles.authTabText, mode === "signup" && styles.authTabTextActive]}>Créer un compte</Text></Pressable></View>
          {mode === "signup" ? <><AuthField label="Nom complet" value={name} onChangeText={setName} autoCapitalize="words" /><AuthField label="Téléphone (facultatif)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" /></> : null}
          <AuthField label="Adresse e-mail" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          <AuthField label="Mot de passe" value={password} onChangeText={setPassword} secureTextEntry />
          {message ? <Text style={styles.successMessage}>{message}</Text> : null}{error ? <Text style={styles.errorMessage}>{error}</Text> : null}
          <Pressable style={[styles.heroButton, busy && styles.buttonBusy]} disabled={busy} onPress={submit}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.heroButtonText}>{mode === "signin" ? "SE CONNECTER" : "CRÉER MON COMPTE"}</Text>}</Pressable>
          <Text style={styles.privacyText}>Vos données sont protégées par les règles d’accès Supabase.</Text>
        </ScrollView>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function AuthField({ label, ...props }: { label: string } & ComponentProps<typeof TextInput>) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput style={styles.fieldInput} placeholder={label} placeholderTextColor={colors.muted} autoCorrect={false} {...props} /></View>;
}

const colors = { green: "#24543b", dark: "#183c2a", paper: "#fbfaf6", cream: "#f6f1e7", orange: "#d98e3c", muted: "#858d82", line: "#e8e7df", white: "#ffffff", text: "#24372c" };

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  scrollContent: { paddingBottom: 26 },
  topBar: { height: 66, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.paper },
  brandMark: { width: 39, height: 39, borderRadius: 13, backgroundColor: "#e6eddf", alignItems: "center", justifyContent: "center", transform: [{ rotate: "-4deg" }] },
  brandLeaf: { color: colors.green, fontSize: 23 },
  brandText: { marginLeft: 10, flex: 1 },
  brandName: { color: colors.dark, fontSize: 22, fontWeight: "800", letterSpacing: -1 },
  brandAccent: { color: colors.orange },
  brandTagline: { fontSize: 8, color: colors.muted, letterSpacing: 1.7, fontWeight: "700", marginTop: 2 },
  bagButton: { borderWidth: 1, borderColor: colors.line, borderRadius: 24, paddingHorizontal: 11, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 },
  bagIcon: { fontSize: 19, color: colors.green }, bagLabel: { fontSize: 12, color: colors.text, fontWeight: "600" }, bagCount: { minWidth: 20, textAlign: "center", overflow: "hidden", backgroundColor: colors.green, color: colors.white, borderRadius: 10, fontSize: 10, fontWeight: "700", paddingVertical: 3, paddingHorizontal: 5 },
  announcement: { marginHorizontal: 18, marginTop: 16, borderRadius: 6, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: colors.dark },
  announcementText: { color: "#f5f2e9", textAlign: "center", fontWeight: "700", letterSpacing: 1.1, fontSize: 9 },
  hero: { paddingHorizontal: 22, paddingTop: 27 }, eyebrow: { color: "#74816f", fontSize: 9, letterSpacing: 1.8, fontWeight: "800" },
  heroTitle: { color: "#203e2d", fontSize: 43, lineHeight: 48, fontWeight: "500", letterSpacing: -1.8, marginTop: 13 }, heroAccent: { color: colors.orange, fontStyle: "italic" },
  heroBody: { color: "#737b71", fontSize: 13, lineHeight: 20, marginTop: 12, maxWidth: 380 },
  heroButton: { backgroundColor: colors.green, borderRadius: 7, paddingVertical: 14, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", minHeight: 46 }, heroButtonText: { color: colors.white, fontSize: 10, letterSpacing: 1, fontWeight: "800" },
  heroImageFrame: { height: 245, marginTop: 22, borderRadius: 20, overflow: "hidden", backgroundColor: colors.cream, position: "relative" }, heroImage: { width: "100%", height: "100%", resizeMode: "cover" },
  imageCaption: { position: "absolute", bottom: 12, left: 12, right: 12, backgroundColor: "#fffdf2ee", padding: 11, borderRadius: 9, flexDirection: "row", alignItems: "center", gap: 10 }, imageCaptionIcon: { fontSize: 23, color: colors.green }, imageCaptionTitle: { fontWeight: "700", color: colors.text, fontSize: 11 }, imageCaptionBody: { color: colors.muted, fontSize: 10, marginTop: 3 },
  promiseRow: { flexDirection: "row", gap: 18, paddingHorizontal: 23, paddingVertical: 21, borderBottomWidth: 1, borderBottomColor: colors.line }, promise: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }, promiseIcon: { color: colors.green, fontSize: 19 }, promiseText: { color: "#667367", fontSize: 10, flexShrink: 1 },
  sectionHeader: { paddingHorizontal: 21, paddingTop: 31, paddingBottom: 16 }, sectionTitle: { color: colors.text, fontSize: 27, fontWeight: "500", letterSpacing: -0.7, marginTop: 9 }, sectionSubtitle: { color: colors.muted, fontSize: 11, marginTop: 5 },
  searchWrap: { marginHorizontal: 19, height: 45, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 7, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }, searchIcon: { color: colors.muted, fontSize: 22, marginRight: 7 }, searchInput: { flex: 1, color: colors.text, fontSize: 12, paddingVertical: 0 },
  categoryRow: { paddingHorizontal: 19, paddingTop: 13, paddingBottom: 7, gap: 7 }, categoryChip: { borderWidth: 1, borderColor: colors.line, borderRadius: 22, paddingHorizontal: 13, paddingVertical: 9 }, categoryChipSelected: { backgroundColor: colors.green, borderColor: colors.green }, categoryText: { color: "#747c72", fontSize: 10, fontWeight: "600" }, categoryTextSelected: { color: colors.white },
  catalogMeta: { paddingHorizontal: 21, paddingTop: 10, paddingBottom: 11, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, catalogCount: { color: colors.text, fontSize: 11, fontWeight: "700" }, catalogMessage: { color: colors.muted, fontSize: 9, flexShrink: 1, textAlign: "right", marginLeft: 8 },
  loading: { alignItems: "center", padding: 35, gap: 10 }, loadingText: { color: colors.muted, fontSize: 12 }, emptyState: { padding: 30, alignItems: "center" }, emptyTitle: { fontFamily: "serif", color: colors.text, fontSize: 21 }, emptyBody: { color: colors.muted, textAlign: "center", fontSize: 12, marginTop: 8 }, resetText: { color: colors.green, fontWeight: "700", marginTop: 16, fontSize: 12 },
  productGrid: { paddingHorizontal: 16 }, productRow: { flexDirection: "row", gap: 10, marginBottom: 11 }, productCard: { flex: 1, backgroundColor: colors.white, borderWidth: 1, borderColor: "#eeede7", borderRadius: 10, overflow: "hidden" }, productCardSpacer: { flex: 1 },
  productImageWrap: { height: 145, backgroundColor: colors.cream, position: "relative" }, productImage: { width: "100%", height: "100%", resizeMode: "cover" }, productBadge: { position: "absolute", top: 8, left: 8, borderRadius: 4, backgroundColor: "#fffdf7", paddingHorizontal: 7, paddingVertical: 5 }, productBadgeText: { color: colors.green, fontSize: 8, fontWeight: "700" }, favoriteButton: { position: "absolute", top: 8, right: 8, width: 28, height: 28, borderRadius: 15, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" }, favoriteIcon: { color: colors.green, fontSize: 19 }, favoriteIconSelected: { color: "#c95345" },
  productInfo: { padding: 10 }, productCategory: { color: "#818a7f", fontSize: 8, letterSpacing: 1, fontWeight: "800" }, productName: { color: "#2c3e31", fontSize: 13, lineHeight: 17, fontWeight: "700", marginTop: 5, minHeight: 34 }, productDescription: { color: "#838980", fontSize: 10, lineHeight: 14, marginTop: 3, minHeight: 28 }, productBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 11 }, priceBlock: { flexShrink: 1 }, productPrice: { color: colors.green, fontSize: 11, fontWeight: "800" }, productUnit: { color: "#899087", fontSize: 9, marginTop: 3 }, addButton: { width: 32, height: 32, borderRadius: 8, backgroundColor: colors.green, alignItems: "center", justifyContent: "center", marginLeft: 4 }, addButtonText: { color: colors.white, fontSize: 20, lineHeight: 22 },
  seasonBanner: { marginHorizontal: 18, marginTop: 29, borderRadius: 13, backgroundColor: "#244b36", padding: 23 }, eyebrowLight: { color: "#c3d5b6", fontSize: 9, letterSpacing: 1.8, fontWeight: "800" }, seasonTitle: { color: colors.white, fontSize: 30, lineHeight: 36, fontFamily: "serif", marginTop: 13 }, seasonAccent: { color: "#f6b45d", fontStyle: "italic" }, seasonBody: { color: "#d4dfd3", fontSize: 11, lineHeight: 18, marginTop: 9 }, seasonButton: { alignSelf: "flex-start", marginTop: 16, backgroundColor: "#f5b45f", paddingHorizontal: 14, paddingVertical: 12, borderRadius: 6 }, seasonButtonText: { color: "#273d2e", fontSize: 9, fontWeight: "800", letterSpacing: 0.6 }, footerNote: { textAlign: "center", paddingVertical: 22, color: colors.muted, fontSize: 10 },
  bottomNav: { minHeight: 61, paddingBottom: 4, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }, navItem: { minWidth: 65, alignItems: "center", gap: 3 }, navIcon: { color: "#92998f", fontSize: 21, lineHeight: 23 }, navIconActive: { color: colors.green }, navLabel: { color: "#92998f", fontSize: 8, fontWeight: "600" }, navLabelActive: { color: colors.green, fontWeight: "800" },
  modalSafe: { flex: 1, backgroundColor: colors.paper, paddingHorizontal: 20 }, modalHeader: { minHeight: 75, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, modalTitle: { fontFamily: "serif", color: colors.text, fontSize: 27, marginTop: 4 }, closeButton: { width: 37, height: 37, borderRadius: 20, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" }, closeText: { color: colors.text, fontSize: 27, lineHeight: 30 }, cartEmpty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 22 }, cartEmptyIcon: { color: colors.green, backgroundColor: "#e9efe3", fontSize: 29, overflow: "hidden", borderRadius: 40, padding: 17 }, cartEmptyTitle: { color: colors.text, fontFamily: "serif", fontSize: 23, textAlign: "center", marginTop: 17 }, cartEmptyBody: { color: colors.muted, fontSize: 12, textAlign: "center", marginTop: 8, marginBottom: 20 }, cartList: { paddingTop: 8, paddingBottom: 15 }, cartLine: { flexDirection: "row", gap: 13, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.line }, cartImage: { width: 82, height: 88, borderRadius: 8 }, cartDetails: { flex: 1, position: "relative", justifyContent: "center" }, cartProductName: { color: colors.text, fontSize: 13, fontWeight: "700" }, cartPrice: { color: colors.green, fontSize: 12, fontWeight: "800", marginTop: 8 }, quantityControl: { position: "absolute", right: 0, bottom: 0, flexDirection: "row", gap: 15, alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 }, quantityButton: { color: colors.green, fontSize: 16, fontWeight: "700" }, quantityValue: { fontSize: 11, color: colors.text }, cartSummary: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 16 }, summaryRow: { flexDirection: "row", justifyContent: "space-between" }, summaryLabel: { color: colors.text, fontSize: 13 }, summaryValue: { color: colors.green, fontSize: 16, fontWeight: "800" }, cartHint: { color: colors.muted, fontSize: 10, marginTop: 7, marginBottom: 13 }, disabledButton: { opacity: 0.75 }, clearCart: { alignSelf: "center", padding: 10 }, clearCartText: { color: colors.muted, textDecorationLine: "underline", fontSize: 11 },
  orderList: { paddingVertical: 14, gap: 12 }, orderCard: { padding: 15, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 10 }, orderNumber: { color: colors.text, fontSize: 13, fontWeight: "800" }, orderStatus: { color: colors.green, fontSize: 11, fontWeight: "800" }, orderDate: { color: colors.muted, fontSize: 10, marginTop: 5, marginBottom: 10 }, orderLine: { color: colors.text, fontSize: 11, lineHeight: 18 }, orderTotalRow: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 10, paddingTop: 10 }, favoriteRow: { width: "100%", marginBottom: 12 },
  authContainer: { flex: 1 }, authForm: { paddingTop: 17, paddingBottom: 30, gap: 14 }, authHelp: { color: colors.muted, fontSize: 12, lineHeight: 19 }, authTabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.line }, authTab: { flex: 1, alignItems: "center", paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: "transparent" }, authTabActive: { borderBottomColor: colors.orange }, authTabText: { color: colors.muted, fontSize: 12 }, authTabTextActive: { color: colors.green, fontWeight: "800" }, field: { gap: 6 }, fieldLabel: { color: "#405447", fontSize: 11, fontWeight: "700" }, fieldInput: { height: 45, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 6, backgroundColor: colors.white, color: colors.text, fontSize: 13 }, successMessage: { color: colors.green, fontSize: 12, lineHeight: 18 }, errorMessage: { color: "#a63d2f", fontSize: 12, lineHeight: 18 }, privacyText: { color: "#92978f", textAlign: "center", fontSize: 10, lineHeight: 16 }, buttonBusy: { opacity: 0.75 },
});

export default function App() { return <NativeApp />; }
