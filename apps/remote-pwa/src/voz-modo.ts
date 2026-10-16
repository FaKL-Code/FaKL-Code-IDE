import { l10n } from '@fakl/i18n';
import { transcricaoDaVoz, type VozStatus } from '@fakl/protocol';
import type { ModoDeVoz } from '@fakl/voz';

/** Dica quando o app não tem como ouvir. */
export function dicaSemVoz(): string {
  return l10n.t("Use your phone keyboard's dictation");
}

/** O que o aparelho oferece (`suporteDeVoz` do @fakl/voz). */
export interface SuporteDoAparelho {
  readonly navegador: boolean;
  readonly gravacao: boolean;
}

/**
 * Como este aparelho ouve, segundo o modo escolhido na IDE (`voz.status`):
 * - modo `navegador`: a Web Speech API do navegador do celular;
 * - modos do Core (OpenAI, Groq, local): grava e o Core transcreve; o
 *   navegador não entra, para a fala não ir a quem a pessoa não escolheu;
 * - sem modo (voz desligada) ou sem resposta da IDE: nada, e a dica diz por quê.
 */
export function escolherModoDeVoz(
  suporte: SuporteDoAparelho,
  status: VozStatus | undefined,
): { modo?: ModoDeVoz; dica?: string } {
  if (!status) {
    return { dica: l10n.t("No response from the IDE. Use your phone keyboard's dictation.") };
  }
  const quem = transcricaoDaVoz(status);
  if (quem === 'navegador') {
    if (suporte.navegador) return { modo: 'navegador' };
    return {
      dica: l10n.t(
        "This browser doesn't recognize speech. Use your phone keyboard's dictation or choose another voice mode in the IDE.",
      ),
    };
  }
  if (quem === 'core') {
    if (suporte.gravacao) return { modo: 'gravacao' };
    return {
      dica: l10n.t("This browser doesn't record audio. Use your phone keyboard's dictation."),
    };
  }
  if (!status.modo) {
    return {
      dica: l10n.t(
        'Voice is off. Choose a mode in the IDE ("FaKL: Configure voice"). Use your phone keyboard\'s dictation.',
      ),
    };
  }
  return {
    dica: status.motivo
      ? l10n.t(
          "Voice isn't ready in the IDE ({0}). Use your phone keyboard's dictation.",
          status.motivo,
        )
      : l10n.t("Voice isn't ready in the IDE. Use your phone keyboard's dictation."),
  };
}
