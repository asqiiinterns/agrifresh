# Screens side by side for the manual: python e2e/manual/montage.py → e2e/shots/m-*.png
from PIL import Image, ImageDraw, ImageFont
import os

SHOTS = os.path.join(os.path.dirname(__file__), "..", "shots")
GROUPS = {
    "m-premiers-pas-1": [("01-connexion", "Connexion"), ("02-accueil-fournisseur", "Accueil d'un fournisseur")],
    "m-premiers-pas-2": [("04-accueil-acheteur", "Accueil d'un acheteur"), ("03-plus-fournisseur", "Menu Plus")],
    "m-acheteur-1": [("10-commander", "Commander"), ("11-mes-commandes", "Mes commandes")],
    "m-acheteur-2": [("13-factures-acheteur", "Mes factures"), ("14-compte-acheteur", "Mon compte chez le fournisseur")],
    "m-acheteur-3": [("15-recurrentes", "Commandes récurrentes"), ("16-decouvrir", "Découvrir")],
    "m-commandes-1": [("20-a-decider", "À décider"), ("21-commandes-en-cours", "Commandes : à décider")],
    "m-commandes-2": [("23-commandes-cloturees", "Commandes clôturées"), ("24-commander-pour-client", "Commander pour un client")],
    "m-production": [("30-planning", "Planning"), ("31-production", "Production"), ("32-production-preparateur", "Vue du préparateur")],
    "m-livraisons": [("40-a-recuperer", "À récupérer"), ("41-a-livrer", "À livrer"), ("42-historique-livraisons", "Historique")],
    "m-facturation-1": [("50-factures", "Factures"), ("51-comptes-clients", "Comptes clients")],
    "m-facturation-2": [("52-tableau-de-bord", "Tableau de bord"), ("53-avoirs", "Avoirs"), ("54-retours", "Retours et avoirs")],
    "m-catalogue": [("60-produits", "Produits"), ("61-remises", "Remises et tarifs")],
    "m-clients": [("70-clients", "Fiches clients"), ("71-reseau", "Réseau")],
    "m-messages-1": [("80-messages", "Messages clients"), ("81-messages-equipe", "Messages d'équipe")],
    "m-messages-2": [("82-notifications", "Notifications"), ("83-messages-acheteur", "Messages côté acheteur")],
    "m-equipe-1": [("90-calendrier", "Calendrier"), ("91-conges", "Demande de congé")],
    "m-equipe-2": [("92-incidents", "Signaler un incident"), ("93-statistiques", "Statistiques"), ("94-localisation", "Localisation")],
    "m-admin-1": [("A0-comptes", "Comptes"), ("A1-roles", "Rôles et accès")],
    "m-admin-2": [("A2-parametrage", "Paramétrage"), ("A3-notifications-emails", "Notifications et e-mails")],
    "m-admin-3": [("A4-flotte", "Flotte"), ("A5-journal", "Journal des actions")],
    "m-admin-4": [("A6-mon-profil", "Mon profil"), ("A7-affichage", "Affichage et langue")],
    "m-approplus": [("B0-pros", "Pros"), ("B1-plateforme-parametrage", "Paramétrage Appro+")],
}
font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 30)
for name, shots in GROUPS.items():
    width = 520 if len(shots) == 2 else 400
    images = []
    for file, _ in shots:
        im = Image.open(os.path.join(SHOTS, f"{file}.png")).convert("RGB")
        images.append(im.resize((width, round(im.height * width / im.width)), Image.LANCZOS))
    gap, pad, label = 40, 30, 60
    height = max(im.height for im in images)
    canvas = Image.new("RGB", (pad * 2 + width * len(images) + gap * (len(images) - 1), pad * 2 + height + label), "white")
    draw = ImageDraw.Draw(canvas)
    for i, (im, (_, caption)) in enumerate(zip(images, shots)):
        x = pad + i * (width + gap)
        canvas.paste(im, (x, pad))
        draw.rectangle([x - 1, pad - 1, x + width, pad + im.height], outline=(214, 219, 226), width=2)
        w = draw.textlength(caption, font=font)
        draw.text((x + (width - w) / 2, pad + height + 16), caption, font=font, fill=(29, 41, 57))
    canvas.save(os.path.join(SHOTS, f"{name}.png"), optimize=True)
    print(name, canvas.size)
