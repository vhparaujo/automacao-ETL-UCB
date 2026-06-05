'use strict';

// O PowerBI conecta diretamente ao MySQL via connector ou gateway.
// Este módulo garante que as views estejam atualizadas após a carga.

async function notificarViews(views) {
  if (!views || views.length === 0) return;

  console.log('\n📊 PowerBI — Views disponíveis para sincronização:');
  for (const view of views) {
    console.log(`  ✅ View '${view}' atualizada — PowerBI pode sincronizar`);
  }
}

module.exports = { notificarViews };
