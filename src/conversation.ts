/* eslint-disable @typescript-eslint/naming-convention */
import type { RealtimeServerEvents } from './events'
import type { Realtime } from './types'
import { assert, base64ToArrayBuffer, mergeInt16Arrays } from './utils'

/**
 * RealtimeConversation holds conversation history and performs event
 * validation for RealtimeAPI.
 */
export class RealtimeConversation {
  readonly defaultFrequency = 24_000 // 24,000 Hz

  itemLookup: Record<string, Realtime.FormattedItem> = {}
  items: Realtime.FormattedItem[] = []
  responseLookup: Record<string, Realtime.Response> = {}
  responses: Realtime.Response[] = []
  queuedSpeechItems: Record<
    string,
    { audio_start_ms: number; audio_end_ms?: number; audio?: Int16Array }
  > = {}
  queuedTranscriptItems: Record<string, { transcript: string }> = {}
  queuedInputAudio?: Int16Array

  constructor() {
    this.clear()
  }

  EventProcessors: Partial<
    Record<RealtimeServerEvents.ServerEventType, (...args: any[]) => any>
  > = {
    'conversation.item.created': (
      event: RealtimeServerEvents.ConversationItemCreatedEvent
    ) => {
      const { item } = event
      // deep copy values
      const newItem: Realtime.FormattedItem = {
        ...structuredClone(item),
        formatted: {
          audio: new Int16Array(0),
          text: '',
          transcript: ''
        }
      }

      if (!this.itemLookup[newItem.id]) {
        this.itemLookup[newItem.id] = newItem
        this.items.push(newItem)
      }

      // If we have a speech item, can populate audio
      if (this.queuedSpeechItems[newItem.id]?.audio) {
        newItem.formatted.audio = this.queuedSpeechItems[newItem.id]!.audio!
        delete this.queuedSpeechItems[newItem.id] // free up some memory
      }

      // Populate formatted text if it comes out on creation
      if (newItem.content) {
        const textContent = newItem.content.filter(
          (c) => c.type === 'text' || c.type === 'input_text'
        ) as Array<Realtime.InputTextContentPart | Realtime.TextContentPart>

        for (const content of textContent) {
          newItem.formatted.text += content.text
        }
      }

      // If we have a transcript item, can pre-populate transcript
      if (this.queuedTranscriptItems[newItem.id]) {
        newItem.formatted.transcript =
          this.queuedTranscriptItems[newItem.id]!.transcript
        delete this.queuedTranscriptItems[newItem.id]
      }

      if (newItem.type === 'message') {
        if (newItem.role === 'user') {
          newItem.status = 'completed'
          if (this.queuedInputAudio) {
            newItem.formatted.audio = this.queuedInputAudio
            this.queuedInputAudio = undefined
          }
        } else {
          newItem.status = 'in_progress'
        }
      } else if (newItem.type === 'function_call') {
        newItem.formatted.tool = {
          type: 'function',
          name: newItem.name,
          call_id: newItem.call_id,
          arguments: ''
        }

        newItem.status = 'in_progress'
      } else if (newItem.type === 'function_call_output') {
        newItem.status = 'completed'
        newItem.formatted.output = newItem.output
      }

      return { item: newItem, delta: null }
    },

    'conversation.item.truncated': (
      event: RealtimeServerEvents.ConversationItemTruncatedEvent
    ) => {
      const { item_id, audio_end_ms } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(`item.truncated: Item "${item_id}" not found`)
      }

      const endIndex = Math.floor((audio_end_ms * this.defaultFrequency) / 1000)
      item.formatted.transcript = ''
      item.formatted.audio = item.formatted.audio!.slice(0, endIndex)

      return { item, delta: null }
    },

    'conversation.item.deleted': (
      event: RealtimeServerEvents.ConversationItemDeletedEvent
    ) => {
      const { item_id } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(`item.deleted: Item "${item_id}" not found`)
      }

      delete this.itemLookup[item.id]
      const index = this.items.indexOf(item)

      if (index > -1) {
        this.items.splice(index, 1)
      }

      return { item, delta: null }
    },

    'conversation.item.input_audio_transcription.completed': (
      event: RealtimeServerEvents.ConversationItemInputAudioTranscriptionCompletedEvent
    ) => {
      const { item_id, content_index, transcript } = event
      const item = this.itemLookup[item_id]

      // We use a single space to represent an empty transcript for .formatted values
      // Otherwise it looks like no transcript provided
      const formattedTranscript = transcript || ' '

      if (!item) {
        // We can receive transcripts in VAD mode before item.created
        // This happens specifically when audio is empty
        this.queuedTranscriptItems[item_id] = {
          transcript: formattedTranscript
        }

        return { item: null, delta: null }
      } else {
        if (item.content[content_index]) {
          ;(
            item.content[content_index] as Realtime.AudioContentPart
          ).transcript = transcript
        }
        item.formatted.transcript = formattedTranscript
        return { item, delta: { transcript } }
      }
    },

    'input_audio_buffer.speech_started': (
      event: RealtimeServerEvents.InputAudioBufferSpeechStartedEvent
    ) => {
      const { item_id, audio_start_ms } = event
      this.queuedSpeechItems[item_id] = { audio_start_ms }
      return { item: null, delta: null }
    },

    'input_audio_buffer.speech_stopped': (
      event: RealtimeServerEvents.InputAudioBufferSpeechStoppedEvent,
      inputAudioBuffer: Int16Array
    ) => {
      const { item_id, audio_end_ms } = event
      if (!this.queuedSpeechItems[item_id]) {
        this.queuedSpeechItems[item_id] = { audio_start_ms: audio_end_ms }
      }

      const speech = this.queuedSpeechItems[item_id]
      assert(speech)
      speech.audio_end_ms = audio_end_ms

      if (inputAudioBuffer) {
        const startIndex = Math.floor(
          (speech.audio_start_ms * this.defaultFrequency) / 1000
        )
        const endIndex = Math.floor(
          (speech.audio_end_ms * this.defaultFrequency) / 1000
        )

        speech.audio = inputAudioBuffer.slice(startIndex, endIndex)
      }

      return { item: null, delta: null }
    },

    'response.created': (event: RealtimeServerEvents.ResponseCreatedEvent) => {
      const { response } = event

      if (!this.responseLookup[response.id]) {
        this.responseLookup[response.id] = response
        this.responses.push(response)
      }

      return { item: null, delta: null }
    },

    'response.output_item.added': (
      event: RealtimeServerEvents.ResponseOutputItemAddedEvent
    ) => {
      const { response_id, item } = event
      const response = this.responseLookup[response_id]

      if (!response) {
        throw new Error(
          `response.output_item.added: Response "${response_id}" not found`
        )
      }

      response.output.push(item)
      return { item: null, delta: null }
    },

    'response.output_item.done': (
      event: RealtimeServerEvents.ResponseOutputItemDoneEvent
    ) => {
      const { item } = event
      if (!item) {
        throw new Error(`response.output_item.done: Missing "item"`)
      }

      const foundItem = this.itemLookup[item.id]
      if (!foundItem) {
        throw new Error(
          `response.output_item.done: Item "${item.id}" not found`
        )
      }

      foundItem.status = item.status
      return { item: foundItem, delta: null }
    },

    'response.content_part.added': (
      event: RealtimeServerEvents.ResponseContentPartItemAddedEvent
    ) => {
      const { item_id, part } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(
          `response.content_part.added: Item "${item_id}" not found`
        )
      }

      item.content.push(part as any)
      return { item, delta: null }
    },

    'response.audio_transcript.delta': (
      event: RealtimeServerEvents.ResponseAudioTranscriptDeltaEvent
    ) => {
      const { item_id, content_index, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(
          `response.audio_transcript.delta: Item "${item_id}" not found`
        )
      }

      ;(item.content[content_index] as Realtime.AudioContentPart).transcript +=
        delta
      item.formatted.transcript += delta

      return { item, delta: { transcript: delta } }
    },

    'response.audio.delta': (
      event: RealtimeServerEvents.ResponseAudioDeltaEvent
    ) => {
      const { item_id, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(`response.audio.delta: Item "${item_id}" not found`)
      }

      // This never gets renderered, we care about the file data instead
      // item.content[content_index].audio += delta;

      const arrayBuffer = base64ToArrayBuffer(delta)
      const appendValues = new Int16Array(arrayBuffer)
      item.formatted.audio = mergeInt16Arrays(
        item.formatted.audio,
        appendValues
      )

      return { item, delta: { audio: appendValues } }
    },

    'response.text.delta': (
      event: RealtimeServerEvents.ResponseTextDeltaEvent
    ) => {
      const { item_id, content_index, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(`response.text.delta: Item "${item_id}" not found`)
      }

      ;(item.content[content_index] as Realtime.TextContentPart).text += delta
      item.formatted.text += delta

      return { item, delta: { text: delta } }
    },

    'response.function_call_arguments.delta': (
      event: RealtimeServerEvents.ResponseFunctionCallArgumentsDeltaEvent
    ) => {
      const { item_id, delta } = event
      const item = this.itemLookup[item_id]
      if (!item) {
        throw new Error(
          `response.function_call_arguments.delta: Item "${item_id}" not found`
        )
      }

      ;(item as Realtime.FunctionCallItem).arguments += delta
      item.formatted.tool!.arguments += delta

      return { item, delta: { arguments: delta } }
    }
  }

  /**
   * Clears the conversation history and resets to defaults.
   */
  clear() {
    this.itemLookup = {}
    this.items = []
    this.responseLookup = {}
    this.responses = []
    this.queuedSpeechItems = {}
    this.queuedTranscriptItems = {}
    this.queuedInputAudio = undefined
  }

  /**
   * Queue input audio for manual speech event
   */
  queueInputAudio(inputAudio: Int16Array) {
    this.queuedInputAudio = inputAudio
  }

  /**
   * Process an event from the WebSocket server and compose items
   */
  processEvent(event: RealtimeServerEvents.ServerEvent, ...args: any[]) {
    if (!event.event_id) {
      console.error(event)
      throw new Error(`Missing "event_id" on event`)
    }

    if (!event.type) {
      console.error(event)
      throw new Error(`Missing "type" on event`)
    }

    const eventProcessor = this.EventProcessors[event.type]
    if (!eventProcessor) {
      throw new Error(
        `Missing realtime server event processor for "${event.type}"`
      )
    }

    return eventProcessor.call(this, event, ...args)
  }

  /**
   * Retrieves an item by ID
   */
  getItem(id: string): Realtime.Item | undefined {
    return this.itemLookup[id]
  }

  /**
   * Retrieves all items in the conversation
   */
  getItems(): Realtime.Item[] {
    return this.items.slice()
  }
}