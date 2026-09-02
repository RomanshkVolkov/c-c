package repository

import (
	"fmt"

	"gorm.io/gorm"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

// Repartir el markdown de cada documento en su pestaña «overview».
//
// Hasta ahora un documento era **un** markdown. Al partirlo en cuatro secciones,
// lo que ya estaba escrito es la primera: nadie escribió un runbook en el campo
// que se llamaba «body», escribió lo que sabía del proyecto.
//
// Corre en cada arranque y es idempotente: sólo escribe donde todavía no hay
// pestaña. Así un reinicio es gratis y un despliegue rodante no se rompe — el
// pod que sigue con el código viejo escribe en `Doc.Body`, y el siguiente
// arranque recoge lo que dejó.
//
// **`Doc.Body` no se borra.** Volver atrás tiene que ser posible con un
// despliegue, no con una restauración de copia de seguridad; y mientras las dos
// formas existan, la vieja es la red de la nueva. Se limpiará cuando lleve unas
// cuantas versiones sin que nadie lo lea.
func backfillDocTabs(db *gorm.DB) {
	var docs []domain.Doc
	if err := db.Where("body <> ''").Find(&docs).Error; err != nil {
		lg.Warn("doc tabs backfill: cannot read documents: " + err.Error())
		return
	}
	if len(docs) == 0 {
		return
	}

	copiados := 0
	for _, d := range docs {
		var existe int64
		if err := db.Model(&domain.DocTab{}).
			Where("doc_id = ? AND key = ?", d.ID, domain.DocOverview).
			Count(&existe).Error; err != nil {
			continue
		}
		// Ya tiene overview: o se migró antes, o alguien la editó ya con el
		// código nuevo. En los dos casos lo de la pestaña es más reciente que
		// `Doc.Body`, así que pisarlo sería perder trabajo.
		if existe > 0 {
			continue
		}
		tab := domain.DocTab{
			DocID:     d.ID,
			Key:       domain.DocOverview,
			Body:      d.Body,
			UpdatedBy: d.UpdatedBy,
		}
		if err := db.Create(&tab).Error; err != nil {
			lg.Warn("doc tabs backfill: cannot split document " + d.ID + ": " + err.Error())
			continue
		}
		copiados++
	}
	if copiados > 0 {
		lg.Info(fmt.Sprintf("doc tabs backfill: %d document(s) moved into their overview tab", copiados))
	}
}
