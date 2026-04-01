import express from 'express'
import { protect } from '../middlewares/authMiddleware.js'
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  toggleFavorite,
} from '../controllers/contactsController.js'

const router = express.Router()

router.get('/',                      protect, listContacts)
router.post('/',                     protect, createContact)
router.put('/:contactId',            protect, updateContact)
router.delete('/:contactId',         protect, deleteContact)
router.patch('/:contactId/favorite', protect, toggleFavorite)

export default router
