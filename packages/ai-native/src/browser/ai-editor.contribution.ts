import { Autowired, INJECTOR_TOKEN, Injectable, Injector } from '@opensumi/di';
import { AINativeConfigService, IAIInlineChatService, PreferenceService } from '@opensumi/ide-core-browser';
import { IBrowserCtxMenu } from '@opensumi/ide-core-browser/lib/menu/next/renderer/ctxmenu/browser';
import {
  AINativeSettingSectionsId,
  CancellationToken,
  Disposable,
  Event,
  IDisposable,
  ILogServiceClient,
  ILoggerManagerClient,
  MaybePromise,
  Schemes,
  SupportLogNamespace,
  runWhenIdle,
} from '@opensumi/ide-core-common';
import { DesignBrowserCtxMenuService } from '@opensumi/ide-design/lib/browser/override/menu.service';
import { IEditor, IEditorFeatureContribution } from '@opensumi/ide-editor/lib/browser';
import * as monaco from '@opensumi/monaco-editor-core/esm/vs/editor/editor.api';

import { AIInlineChatContentWidget } from '../common';

import { AINativeService } from './ai-native.service';
import { CancelResponse, ErrorResponse, IInlineChatFeatureRegistry, ReplyResponse } from './types';
import { InlineChatFeatureRegistry } from './widget/inline-chat/inline-chat.feature.registry';
import { AIInlineChatService, EInlineChatStatus } from './widget/inline-chat/inline-chat.service';
import { AIInlineContentWidget } from './widget/inline-chat/inline-content-widget';
import { AIDiffWidget } from './widget/inline-diff/inline-diff-widget';

@Injectable()
export class AIEditorContribution extends Disposable implements IEditorFeatureContribution {
  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  @Autowired(AINativeConfigService)
  private readonly aiNativeConfigService: AINativeConfigService;

  @Autowired(IAIInlineChatService)
  private readonly aiInlineChatService: AIInlineChatService;

  @Autowired(AINativeService)
  private readonly aiNativeService: AINativeService;

  @Autowired(ILoggerManagerClient)
  private readonly loggerManagerClient: ILoggerManagerClient;

  @Autowired(PreferenceService)
  private readonly preferenceService: PreferenceService;

  @Autowired(IBrowserCtxMenu)
  private readonly ctxMenuRenderer: DesignBrowserCtxMenuService;

  @Autowired(IInlineChatFeatureRegistry)
  private readonly inlineChatFeatureRegistry: InlineChatFeatureRegistry;

  private logger: ILogServiceClient;

  constructor() {
    super();

    this.logger = this.loggerManagerClient.getLogger(SupportLogNamespace.Browser);
  }

  private aiDiffWidget: AIDiffWidget;
  private aiInlineContentWidget: AIInlineContentWidget;
  private aiInlineChatDisposed: Disposable = new Disposable();
  private aiInlineChatOperationDisposed: Disposable = new Disposable();

  private disposeAllWidget() {
    [
      this.aiDiffWidget,
      this.aiInlineContentWidget,
      this.aiInlineChatDisposed,
      this.aiInlineChatOperationDisposed,
    ].forEach((widget) => {
      widget?.dispose();
    });

    this.aiNativeService.cancelToken();
  }

  contribute(editor: IEditor): IDisposable {
    if (!editor) {
      return this;
    }

    const { monacoEditor, currentUri } = editor;
    if (currentUri && currentUri.codeUri.scheme !== Schemes.file) {
      return this;
    }

    this.disposables.push(
      monacoEditor.onDidChangeModel(() => {
        this.disposeAllWidget();
      }),
    );

    this.disposables.push(
      monacoEditor.onDidScrollChange(() => {
        /**
         * 其他的 ctxmenu 服务注册的菜单在 onHide 函数里会有其他逻辑处理，例如在 editor.context.ts 会在 hide 的时候 focus 编辑器，影响使用
         */
        this.ctxMenuRenderer.onHide = undefined;
        this.ctxMenuRenderer.hide(true);
      }),
    );

    this.disposables.push(
      this.aiNativeService.onInlineChatVisible((value: boolean) => {
        if (value) {
          this.registerInlineChat(editor);
        } else {
          this.disposeAllWidget();
        }
      }),
    );

    let isShowInlineChat = false;

    this.disposables.push(
      monacoEditor.onMouseDown(() => {
        isShowInlineChat = false;
      }),
      monacoEditor.onMouseUp((event) => {
        const target = event.target;
        const detail = (target as any).detail;
        if (detail && typeof detail === 'string' && detail === AIInlineChatContentWidget) {
          isShowInlineChat = false;
        } else {
          isShowInlineChat = true;
        }
      }),
    );

    Event.debounce(
      Event.any<any>(monacoEditor.onDidChangeCursorSelection, monacoEditor.onMouseUp),
      (_, e) => e,
      100,
    )(() => {
      if (!this.preferenceService.getValid(AINativeSettingSectionsId.INLINE_CHAT_AUTO_VISIBLE)) {
        return;
      }

      if (!isShowInlineChat) {
        return;
      }

      if (
        this.aiInlineChatService.status !== EInlineChatStatus.READY &&
        this.aiInlineChatService.status !== EInlineChatStatus.ERROR
      ) {
        return;
      }

      this.registerInlineChat(editor);
    });

    return this;
  }

  private async registerInlineChat(editor: IEditor): Promise<void> {
    if (!this.aiNativeConfigService.capabilities.supportsInlineChat) {
      return;
    }

    this.disposeAllWidget();

    const { monacoEditor, currentUri } = editor;

    if (!currentUri || currentUri.codeUri.scheme !== Schemes.file) {
      return;
    }

    const selection = monacoEditor.getSelection();
    const selectCode = selection && monacoEditor.getModel()?.getValueInRange(selection);

    if (!selection || !selectCode?.trim()) {
      this.disposeAllWidget();
      return;
    }

    this.aiInlineChatService.launchChatStatus(EInlineChatStatus.READY);

    this.aiInlineContentWidget = this.injector.get(AIInlineContentWidget, [monacoEditor]);

    this.aiInlineContentWidget.show({
      selection,
    });

    this.aiInlineChatDisposed.addDispose(
      this.aiInlineContentWidget.onClickActions(async (id: string) => {
        const handler = this.inlineChatFeatureRegistry.getHandler(id);
        const action = this.inlineChatFeatureRegistry.getAction(id);
        if (!handler || !action) {
          return;
        }

        const { execute, providerDiffPreviewStrategy } = handler;

        if (execute) {
          execute(editor);
          this.disposeAllWidget();
        }

        if (providerDiffPreviewStrategy) {
          const crossSelection = selection
            .setStartPosition(selection.startLineNumber, 1)
            .setEndPosition(selection.endLineNumber, Number.MAX_SAFE_INTEGER);

          await this.handleDiffPreviewStrategy(editor, providerDiffPreviewStrategy, crossSelection);

          this.aiInlineChatDisposed.addDispose(
            this.aiInlineChatService.onDiscard(() => {
              this.disposeAllWidget();
            }),
          );

          this.aiInlineChatDisposed.addDispose(
            this.aiInlineChatService.onRegenerate(async () => {
              await this.handleDiffPreviewStrategy(editor, providerDiffPreviewStrategy, crossSelection);
            }),
          );
        }
      }),
    );
  }

  private async handleDiffPreviewStrategy(
    editor: IEditor,
    strategy: (
      editor: IEditor,
      cancelToken: CancellationToken,
    ) => MaybePromise<ReplyResponse | ErrorResponse | CancelResponse>,
    crossSelection: monaco.Selection,
  ): Promise<string | undefined> {
    const model = editor.monacoEditor.getModel();
    if (!model || !crossSelection) {
      return;
    }

    this.resetDiffEnvironment();

    const crossCode = model.getValueInRange(crossSelection);
    this.aiInlineChatService.launchChatStatus(EInlineChatStatus.THINKING);

    const response = await strategy(editor, this.aiNativeService.cancelIndicator.token);

    if (this.aiInlineChatDisposed.disposed || CancelResponse.is(response)) {
      this.aiInlineChatService.launchChatStatus(EInlineChatStatus.READY);
      return;
    }

    if (ErrorResponse.is(response)) {
      this.aiInlineChatService.launchChatStatus(EInlineChatStatus.ERROR);
      return;
    }

    this.aiInlineChatService.launchChatStatus(EInlineChatStatus.DONE);
    let answer = this.extractAnswerFromResponse(response as ReplyResponse);
    if (!answer) {
      return;
    }

    answer = this.formatAnswer(answer, crossCode);
    this.visibleDiffWidget(editor, crossSelection, answer);

    this.aiInlineChatOperationDisposed.addDispose([
      this.aiInlineChatService.onAccept(() => {
        editor.monacoEditor
          .getModel()
          ?.pushEditOperations(null, [{ range: crossSelection, text: answer! }], () => null);
        runWhenIdle(() => {
          this.disposeAllWidget();
        });
      }),
      this.aiDiffWidget.onMaxLincCount((count) => {
        requestAnimationFrame(() => {
          if (crossSelection.endLineNumber === model.getLineCount()) {
            const lineHeight = editor.monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
            this.aiInlineContentWidget.offsetTop(lineHeight * count + 12);
          }
        });
      }),
    ]);

    return answer;
  }

  private resetDiffEnvironment(): void {
    this.aiDiffWidget?.dispose();
    this.aiInlineChatOperationDisposed.dispose();
  }

  private extractAnswerFromResponse(response: ReplyResponse): string | undefined {
    const regex = /```\w*([\s\S]+?)\s*```/;
    const match = regex.exec(response.message);
    return match ? match[1].trim() : response.message.trim();
  }

  private formatAnswer(answer: string, crossCode: string): string {
    const leadingWhitespaceMatch = crossCode.match(/^\s*/);
    const indent = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : '  ';
    return answer
      .split('\n')
      .map((line, index) => (index === 0 ? line : `${indent}${line}`))
      .join('\n');
  }

  private visibleDiffWidget(editor: IEditor, crossSelection: monaco.Selection, answer: string): void {
    editor.monacoEditor.setHiddenAreas([crossSelection], AIDiffWidget._hideId);
    this.aiDiffWidget = this.injector.get(AIDiffWidget, [editor.monacoEditor, crossSelection, answer]);
    this.aiDiffWidget.create();
    this.aiDiffWidget.showByLine(
      crossSelection.startLineNumber - 1,
      crossSelection.endLineNumber - crossSelection.startLineNumber + 2,
    );

    this.updateInlineContentWidgetPosition(crossSelection);
  }

  private updateInlineContentWidgetPosition(crossSelection: monaco.Selection): void {
    this.aiInlineContentWidget?.setOptions({
      position: {
        lineNumber: crossSelection.endLineNumber + 1,
        column: 1,
      },
    });
    this.aiInlineContentWidget?.layoutContentWidget();
  }
}