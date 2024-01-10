import TelegramBot from 'node-telegram-bot-api';
import { format, addDays } from 'date-fns';
import { db } from './firebaseConfig'; 
import * as admin from 'firebase-admin';
require('dotenv').config();

const token = process.env.BOT_TOKEN;

if (token === undefined) {
    throw new Error('Environment variables BOT_TOKEN and FIREBASE_PROJECT_ID must be defined');
}
  

const bot = new TelegramBot(token, { polling: true });
const TIME_SLOTS_PER_PAGE = 9;

interface BookingState {
  selectedTimes: string[];
  lastTimeOptionsMessageId?: number;
}

const bookingStates: Record<number, BookingState> = {};

function getBookingState(chatId: number): BookingState {
  if (!bookingStates[chatId]) {
    bookingStates[chatId] = { selectedTimes: [] };
  }
  return bookingStates[chatId];
}

bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  // Welcome message and main menu
  bot.sendMessage(chatId, 'Hello, ' + msg.chat.first_name + '! Welcome to the Tennis Court Booking Bot. What would you like to do?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Check Availability', callback_data: 'check-availability' }],
        [{ text: 'List my Bookings', callback_data: 'list-bookings' }],
      ]
    }
  });


});

bot.on('callback_query', async (callbackQuery) => {

    const message = callbackQuery.message;
    const data = callbackQuery.data;

    if (!message || !data) return;
  
    const chatId = message.chat.id;
    const params = data.split('_');
    const action = params[0];
  
    switch (action) {
      case 'check-availability':
        presentDateOptions(chatId);
        break;
  
      case 'date':
        const selectedDate = params[1];
        await presentTimeOptions(chatId, selectedDate);
        break;
  
      case 'toggle-time':
        const dateForToggle = params[1];
        const timeString = params[2];
        toggleTimeSlot(chatId, dateForToggle, timeString);
        // presentTimeOptions(chatId, dateForToggle); // Refresh time slots
        break;
  
      case 'change-page':
        const dateForPageChange = params[1];
        const newPage = parseInt(params[2]);
        await presentTimeOptions(chatId, dateForPageChange, newPage);
        break;

    //   case 'booked':
    //     bot.answerCallbackQuery(callbackQuery.id, {
    //         text: "This time slot is already booked by someone else.",
    //         show_alert: false
    //       });
    //     break;    

      case 'list-bookings':
        const userId = callbackQuery.from.id;

        if (userId === undefined) {
            bot.sendMessage(chatId, "Unable to identify user.");
            return;
        }

        await listUserBookings(chatId, userId);
        break;  

      case 'cancel-booking':
        const bookingId = data.split('_')[1];
        await cancelBooking(chatId, bookingId);
        break;    
  
      case 'confirm-booking':
        confirmBooking(chatId, callbackQuery.from.first_name, callbackQuery.from.id);
        break;
  
      // Add more cases as needed for other functionalities
    }
  });

  function presentDateOptions(chatId: number) {
    const today = new Date();
    const dateOptions = [];
  
    for (let i = 0; i < 7; i++) {
      const date = addDays(today, i);
      const dateString = format(date, 'yyyy-MM-dd');
      dateOptions.push([{ text: dateString, callback_data: `date_${dateString}` }]);
    }
  
    bot.sendMessage(chatId, 'Please choose a date:', {
      reply_markup: { inline_keyboard: dateOptions }
    });
  }
  
  async function presentTimeOptions(chatId: number, date: string, page: number = 0) {
    const state = getBookingState(chatId);
    const timeSlots = await createTimeSlotsKeyboard(state, date, page);
  
    bot.sendMessage(chatId, 'Please choose a time slot(s):', {
      reply_markup: { inline_keyboard: timeSlots }
    }).then(message => {
      state.lastTimeOptionsMessageId = message.message_id;
    });
  }

  async function listUserBookings(chatId: number, userId: number) {
    const bookings = await getUserBookings(userId);

    if (bookings.length === 0) {
        bot.sendMessage(chatId, "You have no bookings.");
        return;
    }

    for (const booking of bookings) {
        let messageText = `Booking on ${booking.selectedTimes.join(', ')}`;
        let inlineKeyboard = [
            { text: "Cancel Booking", callback_data: `cancel-booking_${booking.id}` }
        ];

        bot.sendMessage(chatId, messageText, {
            reply_markup: { inline_keyboard: [inlineKeyboard] }
        });
    }
  }

  async function cancelBooking(chatId: number, bookingId: string) {
    await db.collection('bookings').doc(bookingId).delete();
    bot.sendMessage(chatId, "Your booking has been successfully canceled.");
}

  async function getUserBookings(userId: number): Promise<any[]> {
    const bookingsSnapshot = await db.collection('bookings')
                                     .where('userId', '==', userId)
                                     .get();

    return bookingsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

  async function toggleTimeSlot(chatId: number, date: string, timeString: string) {
    const state = getBookingState(chatId);
    const dateTimeString = `${date} ${timeString}`;
    const index = state.selectedTimes.indexOf(dateTimeString);
  
    if (index >= 0) {
      // If already selected, allow to deselect
      state.selectedTimes.splice(index, 1);
    } else {
      // Check if the time slot is adjacent to existing selections
      if (isTimeSlotAdjacent(state.selectedTimes, dateTimeString)) {
        state.selectedTimes.push(dateTimeString);
        state.selectedTimes.sort(); // Keep the times sorted
      } else {
        bot.sendMessage(chatId, "Please select a continuous time interval.");
        return;
      }
    }
 
    if (state.lastTimeOptionsMessageId !== undefined) {
        await prepareAndEditTimeOptions(chatId, date, state.lastTimeOptionsMessageId);
      } else {
        await presentTimeOptions(chatId, date);
      }
  }

  function isTimeSlotAdjacent(selectedTimes: string[], newTimeSlot: string): boolean {
    if (selectedTimes.length === 0) {
      return true; // Allow selection if no slots are selected yet
    }
  
    const newSlotTime = convertToDateTime(newTimeSlot);
    if (!(newSlotTime instanceof Date && !isNaN(newSlotTime.getTime()))) {
      return false;
    }
  
    return selectedTimes.some(timeSlot => {
      const slotTime = convertToDateTime(timeSlot);
      if (!(slotTime instanceof Date && !isNaN(slotTime.getTime()))) {
        return false; 
      }
  
      return Math.abs(newSlotTime.getTime() - slotTime.getTime()) === 1800000;
    });
  }
  
  function convertToDateTime(timeSlot: string): Date {
    return new Date(timeSlot.replace(' ', 'T') + ':00'); // Add seconds and 'T' to conform to ISO format
  }

  async function createTimeSlotsKeyboard(state: BookingState, date: string, page: number): Promise<TelegramBot.InlineKeyboardButton[][]> {
    const timeSlots = [];
    let timeRow = [];
    let slotIndex = 0;

    // Time grid buttons
    for (let hour = 7; hour <= 22; hour++) {
        for (let minutes = 0; minutes < 60; minutes += 30) {
          if (slotIndex >= page * TIME_SLOTS_PER_PAGE && slotIndex < (page + 1) * TIME_SLOTS_PER_PAGE) {
            const timeString = `${hour.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            const fullTimeSlot = `${date} ${timeString}`;
    
            const bookedByMe = isSlotBookedByMe(state, fullTimeSlot);
            const booked = !bookedByMe && await isTimeSlotBooked(fullTimeSlot);
    
            let buttonText = bookedByMe ? `🟢 ${timeString}` : (booked ? `❌ ${timeString}` : timeString);
            let callbackData = booked ? 'booked' : `toggle-time_${date}_${timeString}`;
    
            timeRow.push({ text: buttonText, callback_data: callbackData });
    
            if (timeRow.length === 3) {
              timeSlots.push(timeRow);
              timeRow = [];
            }
          }
          slotIndex++;
        }
      }
  
    if (timeRow.length > 0) timeSlots.push(timeRow);
  
    // Navigation buttons
    const navigationButtons = [];
    if (page > 0) {
      navigationButtons.push({ text: '<<', callback_data: `change-page_${date}_${page - 1}` });
    }
    if (slotIndex > (page + 1) * TIME_SLOTS_PER_PAGE) {
      navigationButtons.push({ text: '>>', callback_data: `change-page_${date}_${page + 1}` });
    }
    if (navigationButtons.length > 0) timeSlots.push(navigationButtons);


    // Confirm booking button
    if (state.selectedTimes.length > 0) {
        timeSlots.push([
            { text: "🟢 Confirm Booking", callback_data: "confirm-booking" }
        ]);
    }
  
    return timeSlots;
  }
  

  async function prepareAndEditTimeOptions(chatId: number, date: string, messageId: number, page: number = 0) {
    const state = getBookingState(chatId);
    const timeSlots = await createTimeSlotsKeyboard(state, date, page);
  
    bot.editMessageText('Please choose a time slot:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: timeSlots }
    }).catch(err => console.error(err));
  }

  async function isTimeSlotBooked(timeSlot: string): Promise<boolean> {
    const bookingsSnapshot = await db.collection('bookings').where('selectedTimes', 'array-contains', timeSlot).get();
    return !bookingsSnapshot.empty;
  }

  function isSlotBookedByMe(state: BookingState, timeSlot: string): boolean {
    return state.selectedTimes.includes(timeSlot);
  }
  
  
  function confirmBooking(chatId: number, username: string | undefined, userId: number) {
    const state = getBookingState(chatId);
    if (state.selectedTimes.length === 0) {
      bot.sendMessage(chatId, 'No time slots selected.');
      return;
    } 

    // Create booking object
    const booking = {
      username: username,
      userId: userId,
      chatId: chatId,
      selectedTimes: state.selectedTimes,
      bookedAt: admin.firestore.Timestamp.now()
    };
  
    // Storing in Firestore and sending message with result
    db.collection('bookings').add(booking)
      .then(() => bot.sendMessage(chatId, `Booking confirmed for time frame: ${booking.selectedTimes}`))
      .catch(error => {
        console.error('Error writing document: ', error);
        bot.sendMessage(chatId, 'There was an error in confirming your booking.');
      });
  
    state.selectedTimes = [];
  }