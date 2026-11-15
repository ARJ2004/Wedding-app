import { Share } from 'react-native';

/**
 * Hands a generated text file (CSV) to the OS share sheet (WhatsApp, Drive, email). Native file
 * attachments arrive with APP-04's filesystem module; until then the CSV goes as text.
 */
export async function shareTextFile(name: string, _mime: string, text: string) {
  await Share.share({ title: name, message: text });
}
