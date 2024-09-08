import EventEmitter from 'events';
import { Buffer } from 'node:buffer';

const textToSpeech = require('@google-cloud/text-to-speech');

const client = new textToSpeech.TextToSpeechClient({
  projectId: 'webapp-389506', // Replace with your Google Cloud project ID
  clientConfig: {
    region: 'europe-central2-b', // Replace with the region you want to use
  },
});

export class TextToSpeech extends EventEmitter {

  speechBuffer: Record<number, string> = {};

  constructor() {
    super();
  }

  async generate(llmReply: {
    partialResponseIndex?: number | null;
    partialResponse: string;
  }) {
    const { partialResponseIndex, partialResponse } = llmReply;

    if (!partialResponse) {
      return;
    }

    try {
      const request = {
        input: { text: partialResponse },
        voice: { languageCode: 'en-US',  name: 'en-US-Studio-O' },
        audioConfig: {
          audioEncoding: 'MULAW', // Or another format
          sampleRateHertz: 8000,  // Set the correct sample rate (e.g., 8000 Hz for telephony)
          pitch: 0,
          speakingRate: 1,
          effectsProfileId: ["telephony-class-application"],
        },
      };

      // Performs the text-to-speech request
      const [response] = await client.synthesizeSpeech(request);

      const audioArrayBuffer = response.audioContent;

      if (!audioArrayBuffer) {
        throw new Error('No audio content returned from Text-to-Speech service');
      }

      const audioBase64 = Buffer.from(audioArrayBuffer).toString('base64');

      this.emit(
        'speech',
        partialResponseIndex,
        audioBase64,
        partialResponse,
      );
    } catch (err) {
      console.error(err,'Error occurred in TextToSpeech service:');
      
    }
  }
}
