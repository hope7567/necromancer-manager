# Necromancer Manager

Version 1.0.2 pour Foundry VTT 12 et D&D5e.

- palette native Foundry et adaptation au thème utilisateur ;
- onglet séparé « Groupes et créatures » ;
- création automatique d'un dossier Actor par groupe ;
- rangement du groupe et des copies dans ce dossier ;
- import Plutonium assisté ;
- duplication numérotée ;
- outils de combat conservés.

Ouverture :

```js
game.necromancerManager.open();
```


## Correctifs interface

- la liste « Créature source » ne contient que les acteurs de type `npc` ;
- la liste est reconstruite à chaque ouverture de l'onglet « Groupes et créatures » ;
- les nouvelles créatures importées via Plutonium apparaissent donc immédiatement ;
- les listes déroulantes utilisent un texte noir sur fond clair pour rester lisibles.


## Suppression des groupes

La suppression d'un groupe supprime également le dossier Actor portant le même nom.
Les créatures membres ne sont pas supprimées.


## Rafraîchissement de la liste des créatures

La liste « Créature source » est désormais reconstruite à chaque clic.
Elle affiche donc immédiatement les nouveaux PNJ importés dans Foundry.


## Suppression complète

La suppression d'un groupe efface désormais :
- l'acteur groupe ;
- toutes les créatures contenues dans le dossier du groupe ;
- le dossier lui-même.

Cette suppression est définitive.


## Modifications d'interface et de combat

- après création d'un groupe, l'onglet « Groupes et créatures » reste ouvert ;
- le bouton « Créer et ajouter » est aligné avec les champs ;
- le troisième encadré annonce la documentation à venir ;
- les listes de créatures et de groupes utilisent un fond crème avec du texte noir ;
- les dégâts des attaques ajoutent le modificateur de caractéristique d'attaque lorsqu'il n'est pas déjà présent.


## Activités multiples

Le sélecteur d'action liste désormais chaque activité exploitable séparément :

- attaque ;
- sauvegarde ;
- dégâts directs.

Un même objet peut donc fournir plusieurs choix, par exemple `Dead Cannon — Save` et `Dead Cannon — Damage`.


## Refonte nécromantique

- l'onglet « Groupes et créatures » est restauré après création ou suppression ;
- la suppression utilise une liste dédiée ;
- nouveau style sombre, os et vert nécrotique ;
- les listes déroulantes utilisent un fond crème avec texte noir ;
- les onglets de groupes se compressent pour rester sur une seule ligne.


## Dossiers et interface

- création automatique du dossier racine `NecromancerManager` ;
- chaque groupe est créé dans un sous-dossier de ce dossier racine ;
- le style est appliqué via un conteneur interne, compatible avec le `Dialog` Foundry V12 ;
- toutes les listes déroulantes utilisent un fond crème et du texte noir ;
- la suppression affiche le libellé, la liste et un bouton compact sur une seule ligne.


## Thème clair

- fond blanc et crème ;
- encadrés gris clair ;
- texte noir ;
- boutons blancs classiques ;
- listes déroulantes blanches avec texte noir ;
- seul le bouton de suppression reste rouge.


## Correction des listes déroulantes

- mode de couleur clair forcé sur les contrôles natifs ;
- texte noir et fond blanc appliqués directement à chaque option ;
- apparence native Chromium restaurée ;
- correction appliquée aux listes de PNJ, groupes et activités.


## Derniers ajustements

- la liste « Créature source » ne contient que les PNJ du dossier Actor `Creatures` ;
- les deux onglets principaux sont regroupés dans un bandeau compact ;
- le fond général est gris clair ;
- boutons et listes ont une bordure noire ;
- les boutons de création, ajout et suppression ont la même largeur et sont alignés verticalement.


## Ajustements supplémentaires

- les trois boutons de gestion ont la même largeur et restent chacun dans leur encadré ;
- renommer un groupe renomme aussi son dossier ;
- « Ajouter » devient « Ajouter/retirer » ;
- le champ « Dégâts » est supprimé ;
- « Skeletor actifs » devient « Squelettes actifs » ;
- l'onglet « Skeletor » devient « Squelette ».


## Ajustements d'ouverture et de PV

- l'application s'ouvre toujours sur « Gestion de la horde » ;
- les champs PV sont centrés ;
- « Ajouter/retirer PV » remplace l'ancien libellé ;
- « Ajouter/retirer PV temporaire » permet aussi les valeurs négatives ;
- le bouton d'ouverture de Plutonium a été retiré.


## Thème sombre lisible

- fond gris anthracite, sans noir profond ;
- panneaux gris moyen clairement séparés ;
- textes blancs cassés ;
- boutons et champs clairs avec texte noir ;
- listes déroulantes crème avec texte noir ;
- lignes de tableaux alternées et survol contrasté.


## Navigation, chat et alignement

- les noms et identifiants de groupes sont retirés des messages de chat ;
- après création, ajout de créatures ou suppression, l'onglet « Groupes et créatures » reste affiché ;
- « Créer et ajouter » est aligné avec la liste « Groupe cible » ;
- « Créer un groupe » commence juste sous le séparateur de son encadré.


## Correction d'alignement

Les trois encadrés de gestion utilisent maintenant le même gabarit :
- titre et séparateur identiques ;
- contenu à gauche ;
- bouton de largeur identique à droite ;
- champs et boutons alignés sur la même ligne de base.


## Interface compacte

- boutons de gestion réduits à 180 × 38 px ;
- champs et listes réduits à 38 px de hauteur ;
- alignement conservé.


## Données par utilisateur

- chaque utilisateur voit uniquement ses groupes enregistrés dans ses flags utilisateur ;
- les acteurs créés appartiennent à cet utilisateur ;
- les dossiers sont organisés sous `NecromancerManager/<Utilisateur>/<Groupe>` ;
- le MJ dispose d'un sélecteur pour consulter et administrer les listes de chaque utilisateur.


## Changelog
See CHANGELOG.md for version history.
